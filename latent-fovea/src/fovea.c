// Foveated latent-space renderer: WebAssembly kernel.
//
// Everything that scales with N (points) or D (latent dims) lives here, in
// linear memory the page reads directly. JS only moves the gaze, blits the
// framebuffer, and draws a thin overlay.
//
// Data layout: points are sorted into a GxG grid over the 2D projection, and
// the D-dim vectors are stored cell-major. A grid cell is therefore one
// contiguous byte range: the unit of "foveated streaming".

typedef unsigned int u32;
typedef unsigned char u8;

#define G 256
#define GG (G * G)
#define LEVELS 5
#define FMAX 8192
#define DMAX 128
#define CMAX 32
#define KMAX 64
#define T 32
#define QMAX 1024
#define PARA_MAX 160000.0f

#define EXPORT __attribute__((visibility("default")))

extern unsigned char __heap_base;
static u32 heap_ptr;

static void *alloc(u32 bytes) {
  u32 p = (heap_ptr + 15u) & ~15u;
  u32 end = p + bytes;
  u32 have = (u32)__builtin_wasm_memory_size(0) * 65536u;
  if (end > have) {
    u32 pages = (end - have + 65535u) / 65536u;
    if (__builtin_wasm_memory_grow(0, pages) == (unsigned long)-1) return 0;
  }
  heap_ptr = end;
  return (void *)p;
}

// ---------- math without libm ----------
static inline float fabsf_(float x) { return x < 0 ? -x : x; }
static inline float fsqrt(float x) { return __builtin_sqrtf(x); }
static inline float ffloor(float x) { return __builtin_floorf(x); }
static float fsin(float x) {
  const float PI = 3.14159265f, TAU = 6.28318531f;
  x = x - TAU * ffloor((x + PI) / TAU);  // [-pi, pi)
  if (x > PI * 0.5f) x = PI - x;
  else if (x < -PI * 0.5f) x = -PI - x;
  float x2 = x * x;
  return x * (1.0f - x2 / 6.0f * (1.0f - x2 / 20.0f * (1.0f - x2 / 42.0f)));
}
static inline float smoothstep(float a, float b, float x) {
  float t = (x - a) / (b - a);
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return t * t * (3.0f - 2.0f * t);
}

// ---------- rng ----------
static u32 rs = 1;
static inline u32 xr(void) { rs ^= rs << 13; rs ^= rs >> 17; rs ^= rs << 5; return rs; }
static inline float urand(void) { return (float)(xr() >> 8) * (1.0f / 16777216.0f); }
static inline float grand(void) { return (urand() + urand() + urand() + urand() - 2.0f) * 1.7320508f; }
static inline u32 hash32(u32 x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}

// ---------- state ----------
static u32 N_, D_, K_, seed_;
static float *X;      // N*D, cell-major
static float *P;      // N*2, world coords in [0,1]
static u8 *LAB;       // N
static u32 *cellStart;  // GG+1
static float *pyr[LEVELS];  // (count, r, g, b) per cell
static float densK;

static float mu[CMAX * DMAX], U[CMAX * DMAX], V[CMAX * DMAX], W[CMAX * DMAX];
static float cw[CMAX];
static float gmean[DMAX], gpc[2 * DMAX];
static float lpc[2 * DMAX];
static int lpcInit;
static float lensK;

static u8 *resident;
static u32 *lastUsed;
static float residentBytes, streamCredit, residentCap = 16e6f;
static u32 clockHand;

static u32 *fb;
static u32 fbW, fbH, fbCap;

static u32 fidx[FMAX];
static float floc[FMAX * 2];   // global screen position
static float fdisp[FMAX * 2];  // displayed (lens) position
static u32 fcount;

static u32 queue[QMAX];
static float qdist[QMAX];

static float stats[32];
static u8 pal[256 * 3];
static float *basis;  // D * T*T
static u32 knnIdx[KMAX];
static float knnDist[KMAX];
static u8 thumb[T * T * 4];

EXPORT u8 *ptr_pal(void) { return pal; }
EXPORT float *ptr_stats(void) { return stats; }
EXPORT float *ptr_X(void) { return X; }
EXPORT float *ptr_P(void) { return P; }
EXPORT u8 *ptr_lab(void) { return LAB; }
EXPORT u32 *ptr_fidx(void) { return fidx; }
EXPORT float *ptr_fdisp(void) { return fdisp; }
EXPORT u32 *ptr_knn(void) { return knnIdx; }
EXPORT float *ptr_knnd(void) { return knnDist; }
EXPORT u8 *ptr_thumb(void) { return thumb; }
EXPORT void set_cache(float bytes) { residentCap = bytes; }

// ---------- synthetic latent space ----------
// 6 families x 4 clusters. Each cluster is a curved 2D sheet in D dims.
// Families dominate global variance, so a global projection crowds the
// clusters inside a family together; a local projection pulls them apart.
static void setup_model(void) {
  const u32 F = 6;
  float fc[6 * DMAX];
  rs = hash32(seed_ ^ 0x9e3779b9u) | 1u;
  for (u32 i = 0; i < F * D_; i++) fc[i] = grand() * 1.15f;
  float wsum = 0;
  for (u32 c = 0; c < K_; c++) {
    u32 f = c % F;
    for (u32 d = 0; d < D_; d++) mu[c * D_ + d] = fc[f * D_ + d] + grand() * 0.42f;
    float *vs[3] = {U + c * D_, V + c * D_, W + c * D_};
    for (int k = 0; k < 3; k++) {
      float n = 0;
      for (u32 d = 0; d < D_; d++) { float g = grand(); vs[k][d] = g; n += g * g; }
      n = 1.0f / fsqrt(n);
      for (u32 d = 0; d < D_; d++) vs[k][d] *= n;
    }
    wsum += 0.35f + urand();
    cw[c] = wsum;
  }
  for (u32 c = 0; c < K_; c++) cw[c] /= wsum;
}

static u32 gen_point(u32 i, float *out) {
  rs = hash32(i * 2654435761u ^ seed_) | 1u;
  xr();
  float r = urand();
  u32 c = 0;
  while (c + 1 < K_ && r > cw[c]) c++;
  float a = grand(), b = grand();
  float s = 0.6f * fsin(1.7f * a);
  const float *m = mu + c * D_, *u = U + c * D_, *v = V + c * D_, *w = W + c * D_;
  a *= 0.9f; b *= 0.5f;
  for (u32 d = 0; d < D_; d++)
    out[d] = m[d] + a * u[d] + b * v[d] + s * w[d] + (urand() - 0.5f) * 0.42f;
  return c;
}

// Two leading principal directions by subspace iteration.
static void pca2(const float *Xs, u32 n, const float *mean, float *pc, int iters) {
  float w1[DMAX], w2[DMAX], y[DMAX];
  const u32 D = D_;
  for (int it = 0; it < iters; it++) {
    for (u32 d = 0; d < D; d++) { w1[d] = 0; w2[d] = 0; }
    for (u32 i = 0; i < n; i++) {
      const float *x = Xs + i * D;
      float a1 = 0, a2 = 0;
      for (u32 d = 0; d < D; d++) { y[d] = x[d] - mean[d]; a1 += y[d] * pc[d]; a2 += y[d] * pc[D + d]; }
      for (u32 d = 0; d < D; d++) { w1[d] += a1 * y[d]; w2[d] += a2 * y[d]; }
    }
    float n1 = 0;
    for (u32 d = 0; d < D; d++) n1 += w1[d] * w1[d];
    n1 = 1.0f / fsqrt(n1 + 1e-20f);
    float dp = 0;
    for (u32 d = 0; d < D; d++) { w1[d] *= n1; dp += w1[d] * w2[d]; }
    float n2 = 0;
    for (u32 d = 0; d < D; d++) { w2[d] -= dp * w1[d]; n2 += w2[d] * w2[d]; }
    n2 = 1.0f / fsqrt(n2 + 1e-20f);
    for (u32 d = 0; d < D; d++) { pc[d] = w1[d]; pc[D + d] = w2[d] * n2; }
  }
}

static inline u32 cell_of(float x, float y) {
  int cx = (int)(x * G), cy = (int)(y * G);
  cx = cx < 0 ? 0 : (cx >= G ? G - 1 : cx);
  cy = cy < 0 ? 0 : (cy >= G ? G - 1 : cy);
  return (u32)(cy * G + cx);
}

EXPORT u32 init(u32 n, u32 d, u32 k, u32 seed) {
  if (!heap_ptr) heap_ptr = (u32)&__heap_base;
  heap_ptr = (u32)&__heap_base;
  fb = 0; fbCap = 0;
  N_ = n; D_ = d > DMAX ? DMAX : d; K_ = k > CMAX ? CMAX : k; seed_ = seed;
  const u32 D = D_;
  setup_model();

  X = alloc(N_ * D * 4);
  P = alloc(N_ * 8);
  LAB = alloc(N_);
  cellStart = alloc((GG + 1) * 4);
  for (u32 l = 0; l < LEVELS; l++) { u32 r = G >> l; pyr[l] = alloc(r * r * 16); }
  resident = alloc(GG);
  lastUsed = alloc(GG * 4);
  basis = alloc(D * T * T * 4);
  if (!basis) return 1;
  u32 persistentTop = heap_ptr;

  // Global PCA on a sample.
  u32 S = N_ < 16384 ? N_ : 16384;
  float *Xs = alloc(S * D * 4);
  if (!Xs) return 1;
  for (u32 d = 0; d < D; d++) gmean[d] = 0;
  for (u32 i = 0; i < S; i++) {
    gen_point(hash32(i + 77u) % N_, Xs + i * D);
    for (u32 d = 0; d < D; d++) gmean[d] += Xs[i * D + d];
  }
  for (u32 d = 0; d < D; d++) gmean[d] /= (float)S;
  rs = 12345u;
  for (u32 d = 0; d < 2 * D; d++) gpc[d] = grand();
  pca2(Xs, S, gmean, gpc, 24);
  heap_ptr = persistentTop;

  // Pass 1: project every point, bin into the grid.
  float *Pt = alloc(N_ * 8);
  u8 *Lt = alloc(N_);
  u32 *dest = alloc(N_ * 4);
  if (!dest) return 1;
  float x[DMAX];
  float mnx = 1e30f, mny = 1e30f, mxx = -1e30f, mxy = -1e30f;
  for (u32 i = 0; i < N_; i++) {
    Lt[i] = (u8)gen_point(i, x);
    float a = 0, b = 0;
    for (u32 j = 0; j < D; j++) { float y = x[j] - gmean[j]; a += y * gpc[j]; b += y * gpc[D + j]; }
    Pt[2 * i] = a; Pt[2 * i + 1] = b;
    if (a < mnx) mnx = a; if (a > mxx) mxx = a;
    if (b < mny) mny = b; if (b > mxy) mxy = b;
  }
  float span = (mxx - mnx) > (mxy - mny) ? (mxx - mnx) : (mxy - mny);
  float inv = 0.94f / span;
  float ox = 0.5f - (mxx - mnx) * inv * 0.5f, oy = 0.5f - (mxy - mny) * inv * 0.5f;
  for (u32 c = 0; c <= GG; c++) cellStart[c] = 0;
  for (u32 i = 0; i < N_; i++) {
    float px = (Pt[2 * i] - mnx) * inv + ox, py = (mxy - Pt[2 * i + 1]) * inv + oy;
    Pt[2 * i] = px; Pt[2 * i + 1] = py;
    u32 c = cell_of(px, py);
    dest[i] = c;
    cellStart[c + 1]++;
  }
  for (u32 c = 0; c < GG; c++) cellStart[c + 1] += cellStart[c];
  u32 *cursor = lastUsed;  // borrow as scratch
  for (u32 c = 0; c < GG; c++) cursor[c] = cellStart[c];
  for (u32 i = 0; i < N_; i++) {
    u32 j = cursor[dest[i]]++;
    dest[i] = j;
    P[2 * j] = Pt[2 * i]; P[2 * j + 1] = Pt[2 * i + 1];
    LAB[j] = Lt[i];
  }
  // Pass 2: regenerate vectors straight into their cell-major slot.
  for (u32 i = 0; i < N_; i++) gen_point(i, X + dest[i] * D);
  heap_ptr = persistentTop;

  // Density pyramid (the only thing the periphery ever reads).
  float *L0 = pyr[0];
  for (u32 c = 0; c < GG * 4; c++) L0[c] = 0;
  u32 nonEmpty = 0;
  for (u32 c = 0; c < GG; c++) {
    u32 s = cellStart[c], e = cellStart[c + 1];
    if (e > s) nonEmpty++;
    for (u32 i = s; i < e; i++) {
      const u8 *col = pal + LAB[i] * 3;
      L0[c * 4] += 1; L0[c * 4 + 1] += col[0]; L0[c * 4 + 2] += col[1]; L0[c * 4 + 3] += col[2];
    }
  }
  for (u32 l = 1; l < LEVELS; l++) {
    u32 r = G >> l, pr = r * 2;
    float *dst = pyr[l], *src = pyr[l - 1];
    for (u32 y = 0; y < r; y++)
      for (u32 xx = 0; xx < r; xx++)
        for (u32 ch = 0; ch < 4; ch++) {
          u32 a = ((2 * y) * pr + 2 * xx) * 4 + ch;
          dst[(y * r + xx) * 4 + ch] = src[a] + src[a + 4] + src[a + pr * 4] + src[a + pr * 4 + 4];
        }
  }
  densK = (float)N_ / (float)(nonEmpty ? nonEmpty : 1) * 0.7f;

  // Decoder basis: smooth localized ripples, one per latent dim.
  rs = hash32(seed_ + 991u) | 1u;
  for (u32 d = 0; d < D; d++) {
    float fx = (urand() - 0.5f) * 22.0f, fy = (urand() - 0.5f) * 22.0f, ph = urand() * 6.283f;
    float cx = 0.15f + urand() * 0.7f, cy = 0.15f + urand() * 0.7f, s = 0.06f + urand() * 0.25f;
    for (u32 p = 0; p < T * T; p++) {
      float u = ((p % T) + 0.5f) / T, v = ((p / T) + 0.5f) / T;
      float r2 = ((u - cx) * (u - cx) + (v - cy) * (v - cy)) / s;
      float bump = r2 < 1.0f ? (1.0f - r2) * (1.0f - r2) : 0.0f;
      basis[d * T * T + p] = fsin(fx * u + fy * v + ph) * (0.25f + bump);
    }
  }

  for (u32 c = 0; c < GG; c++) { resident[c] = 0; lastUsed[c] = 0; }
  residentBytes = 0; streamCredit = 0; clockHand = 0;
  lpcInit = 0; lensK = 0;
  stats[6] = (float)N_ * D * 4;
  return 0;
}

EXPORT void flush_cache(void) {
  for (u32 c = 0; c < GG; c++) resident[c] = 0;
  residentBytes = 0; streamCredit = 0;
}

EXPORT u32 *fb_alloc(u32 w, u32 h) {
  if (w * h > fbCap) { fb = alloc(w * h * 4); fbCap = fb ? w * h : 0; }
  fbW = w; fbH = h;
  return fb;
}

// ---------- raster helpers ----------
#define BG_R 2
#define BG_G 6
#define BG_B 23

static inline u32 pack(u32 r, u32 g, u32 b) { return 0xFF000000u | (b << 16) | (g << 8) | r; }

static inline void add_pix(int x, int y, u32 r, u32 g, u32 b) {
  if ((unsigned)x >= fbW || (unsigned)y >= fbH) return;
  u32 *p = fb + (u32)y * fbW + (u32)x;
  u32 v = *p;
  u32 R = (v & 255) + r, Gc = ((v >> 8) & 255) + g, B = ((v >> 16) & 255) + b;
  *p = pack(R > 255 ? 255 : R, Gc > 255 ? 255 : Gc, B > 255 ? 255 : B);
}

// Blend toward a colour (alpha 0..256) so dense regions keep their hue.
static inline void mix_pix(int x, int y, const u8 *c, u32 a) {
  if ((unsigned)x >= fbW || (unsigned)y >= fbH) return;
  u32 *p = fb + (u32)y * fbW + (u32)x;
  u32 v = *p, R = v & 255, Gc = (v >> 8) & 255, B = (v >> 16) & 255;
  R += (int)((int)c[0] - (int)R) * (int)a >> 8;
  Gc += (int)((int)c[1] - (int)Gc) * (int)a >> 8;
  B += (int)((int)c[2] - (int)B) * (int)a >> 8;
  *p = pack(R, Gc, B);
}

static inline void set_pix(int x, int y, u32 c) {
  if ((unsigned)x >= fbW || (unsigned)y >= fbH) return;
  fb[(u32)y * fbW + (u32)x] = c;
}

static void disc(float fx, float fy, const u8 *col, int big) {
  int x = (int)fx, y = (int)fy;
  u32 r = col[0] + 40, g = col[1] + 40, b = col[2] + 40;
  r = r > 255 ? 255 : r; g = g > 255 ? 255 : g; b = b > 255 ? 255 : b;
  u32 c = pack(r, g, b);
  set_pix(x, y, c); set_pix(x + 1, y, c); set_pix(x - 1, y, c); set_pix(x, y + 1, c); set_pix(x, y - 1, c);
  if (big) {
    set_pix(x + 1, y + 1, c); set_pix(x - 1, y - 1, c); set_pix(x + 1, y - 1, c); set_pix(x - 1, y + 1, c);
  } else {
    add_pix(x + 1, y + 1, r / 3, g / 3, b / 3); add_pix(x - 1, y - 1, r / 3, g / 3, b / 3);
    add_pix(x + 1, y - 1, r / 3, g / 3, b / 3); add_pix(x - 1, y + 1, r / 3, g / 3, b / 3);
  }
}

// Bilinear sample of one pyramid level -> premultiplied color.
static void sample_level(u32 l, float wx, float wy, float *out) {
  u32 r = G >> l;
  float fx = wx * r - 0.5f, fy = wy * r - 0.5f;
  int ix = (int)ffloor(fx), iy = (int)ffloor(fy);
  float tx = fx - ix, ty = fy - iy;
  float acc[4] = {0, 0, 0, 0};
  const float *L = pyr[l];
  for (int j = 0; j < 2; j++)
    for (int i = 0; i < 2; i++) {
      int x = ix + i, y = iy + j;
      if (x < 0 || y < 0 || x >= (int)r || y >= (int)r) continue;
      float w = (i ? tx : 1 - tx) * (j ? ty : 1 - ty);
      const float *c = L + (y * r + x) * 4;
      acc[0] += w * c[0]; acc[1] += w * c[1]; acc[2] += w * c[2]; acc[3] += w * c[3];
    }
  if (acc[0] < 1e-4f) { out[0] = out[1] = out[2] = 0; return; }
  float dens = acc[0] / (float)(1u << (2 * l));
  float inten = dens / (dens + densK);
  float k = inten / acc[0];
  out[0] = acc[1] * k; out[1] = acc[2] * k; out[2] = acc[3] * k;
}

// ---------- the frame ----------
// flags: 1 = foveated, 2 = lens on, 4 = tint shading-rate tiers
EXPORT void render(u32 w, u32 h, float camX, float camY, float scale, float gx, float gy,
                   float r0, float r1, u32 flags, float budget, u32 frame, float lensMix) {
  if (!fb || w != fbW || h != fbH) return;
  const int fov = flags & 1, tiers = flags & 4;
  const float hw = w * 0.5f, hh = h * 0.5f, is = 1.0f / scale;
  const u32 D = D_;
  float touched = 0, paraDrawn = 0;
  fcount = 0;

  // A. Background: density pyramid with variable-rate shading.
  const float vrs2 = r0 + 8.0f, vrs4 = r1 * 1.1f, vrs8 = r1 * 1.8f;
  for (u32 by = 0; by < h; by += 8)
    for (u32 bx = 0; bx < w; bx += 8) {
      float tcx = bx + 4.0f - gx, tcy = by + 4.0f - gy;
      float te = fsqrt(tcx * tcx + tcy * tcy);
      u32 rate = !fov ? 1 : (te < vrs2 ? 1 : (te < vrs4 ? 2 : (te < vrs8 ? 4 : 8)));
      for (u32 sy = by; sy < by + 8 && sy < h; sy += rate)
        for (u32 sx = bx; sx < bx + 8 && sx < w; sx += rate) {
          float px = sx + rate * 0.5f, py = sy + rate * 0.5f;
          float dx = px - gx, dy = py - gy;
          float e = fsqrt(dx * dx + dy * dy);
          u32 lvl = 0;
          float wgt;
          if (fov) {
            if (e > r1) { float lf = 1.0f + (e - r1) / (r1 * 0.55f); lvl = lf >= LEVELS - 1 ? LEVELS - 1 : (u32)lf; }
            wgt = 0.2f + 0.8f * smoothstep(r0, r1, e);
            if (flags & 2) wgt *= 1.0f - 0.8f * lensMix * (1.0f - smoothstep(r0 - 6.0f, r0, e));
          } else {
            wgt = 0.35f;
          }
          float c[3];
          sample_level(lvl, (px - hw) * is + camX, (py - hh) * is + camY, c);
          u32 R = BG_R + (u32)(c[0] * wgt), Gc = BG_G + (u32)(c[1] * wgt), B = BG_B + (u32)(c[2] * wgt);
          if (tiers && rate > 1) {
            if (rate == 2) { B += 12; } else if (rate == 4) { R += 10; B += 4; } else { R += 18; }
            if ((sx & 7) == 0 || (sy & 7) == 0) { R += 6; Gc += 6; B += 10; }
          }
          u32 col = pack(R > 255 ? 255 : R, Gc > 255 ? 255 : Gc, B > 255 ? 255 : B);
          for (u32 yy = sy; yy < sy + rate && yy < h; yy++) {
            u32 *row = fb + yy * w;
            for (u32 xx = sx; xx < sx + rate && xx < w; xx++) row[xx] = col;
          }
        }
    }

  float nearestD = 1e30f;
  int focus = -1;

  if (!fov) {
    // Baseline: every point, every frame, full detail.
    for (u32 i = 0; i < N_; i++) {
      float sx = (P[2 * i] - camX) * scale + hw, sy = (P[2 * i + 1] - camY) * scale + hh;
      const u8 *c = pal + LAB[i] * 3;
      mix_pix((int)sx, (int)sy, c, 110);
      float dx = sx - gx, dy = sy - gy, d2 = dx * dx + dy * dy;
      if (d2 < nearestD) { nearestD = d2; focus = (int)i; }
    }
    touched = (float)N_;
    stats[0] = touched; stats[1] = 0; stats[2] = (float)N_; stats[3] = 0; stats[4] = 0;
    stats[5] = stats[6]; stats[7] = nearestD < 900.0f ? (float)focus : -1.0f; stats[8] = 0;
    return;
  }

  // B. Walk only the grid cells under the parafovea.
  float wx0 = (gx - r1 - hw) * is + camX, wx1 = (gx + r1 - hw) * is + camX;
  float wy0 = (gy - r1 - hh) * is + camY, wy1 = (gy + r1 - hh) * is + camY;
  int cx0 = (int)(wx0 * G), cx1 = (int)(wx1 * G), cy0 = (int)(wy0 * G), cy1 = (int)(wy1 * G);
  cx0 = cx0 < 0 ? 0 : cx0; cy0 = cy0 < 0 ? 0 : cy0;
  cx1 = cx1 >= G ? G - 1 : cx1; cy1 = cy1 >= G ? G - 1 : cy1;
  const float cellPx = scale / G, hd = cellPx * 0.7072f;
  float estPara = 0, estFov = 0;
  u32 qn = 0;
  for (int cy = cy0; cy <= cy1; cy++)
    for (int cx = cx0; cx <= cx1; cx++) {
      u32 cell = cy * G + cx, cnt = cellStart[cell + 1] - cellStart[cell];
      if (!cnt) continue;
      float ex = (cx + 0.5f) * cellPx - camX * scale + hw - gx, ey = (cy + 0.5f) * cellPx - camY * scale + hh - gy;
      float ec = fsqrt(ex * ex + ey * ey) - hd;
      if (ec > r1) continue;
      float pp = 1.0f - smoothstep(r0, r1, ec);
      estPara += cnt * (0.08f + 0.92f * pp * pp);
      if (ec < r0) {
        if (resident[cell]) estFov += cnt;
      }
      if (!resident[cell] && ec < r0 * 1.25f && qn < QMAX) { queue[qn] = cell; qdist[qn] = ec; qn++; }
    }
  float paraScale = estPara > PARA_MAX ? PARA_MAX / estPara : 1.0f;
  float ff = estFov > FMAX ? (float)FMAX / estFov : 1.0f;
  const float r0s = r0 * r0, r1s = r1 * r1;

  for (int cy = cy0; cy <= cy1; cy++)
    for (int cx = cx0; cx <= cx1; cx++) {
      u32 cell = cy * G + cx, s = cellStart[cell], cnt = cellStart[cell + 1] - s;
      if (!cnt) continue;
      float ex = (cx + 0.5f) * cellPx - camX * scale + hw - gx, ey = (cy + 0.5f) * cellPx - camY * scale + hh - gy;
      float ec = fsqrt(ex * ex + ey * ey) - hd;
      if (ec > r1) continue;
      float pp = 1.0f - smoothstep(r0, r1, ec);
      u32 nP = (u32)(cnt * (0.08f + 0.92f * pp * pp) * paraScale + 0.999f);
      u32 res = resident[cell];
      u32 nF = (ec < r0 && res) ? (u32)(cnt * ff + 0.999f) : 0;
      if (nF) lastUsed[cell] = frame;
      u32 n = nP > nF ? nP : nF;
      if (n > cnt) n = cnt;
      touched += n;
      for (u32 j = 0; j < n; j++) {
        u32 i = s + j;
        float sx = (P[2 * i] - camX) * scale + hw, sy = (P[2 * i + 1] - camY) * scale + hh;
        float dx = sx - gx, dy = sy - gy, e2 = dx * dx + dy * dy;
        const u8 *c = pal + LAB[i] * 3;
        if (e2 < r0s) {
          if (res) {
            if (j < nF && fcount < FMAX) { fidx[fcount] = i; floc[2 * fcount] = sx; floc[2 * fcount + 1] = sy; fcount++; }
          } else if (j < nP) {
            mix_pix((int)sx, (int)sy, c, 90);  // not streamed yet: low detail
            paraDrawn++;
          }
        } else if (e2 < r1s && j < nP) {
          float e = fsqrt(e2);
          mix_pix((int)sx, (int)sy, c, (u32)(150.0f - 100.0f * smoothstep(r0, r1, e)));
          paraDrawn++;
        }
      }
    }

  // C. Foveated streaming: fetch cell tiles nearest the gaze first.
  for (u32 a = 1; a < qn; a++) {
    u32 qc = queue[a]; float qd = qdist[a]; int b = (int)a - 1;
    while (b >= 0 && qdist[b] > qd) { queue[b + 1] = queue[b]; qdist[b + 1] = qdist[b]; b--; }
    queue[b + 1] = qc; qdist[b + 1] = qd;
  }
  streamCredit += budget;
  float loaded = 0;
  for (u32 q = 0; q < qn; q++) {
    u32 cell = queue[q];
    float bytes = (float)(cellStart[cell + 1] - cellStart[cell]) * D * 4;
    if (bytes > streamCredit) break;
    streamCredit -= bytes; loaded += bytes;
    resident[cell] = 1; lastUsed[cell] = frame; residentBytes += bytes;
  }
  float creditCap = budget * 8 > 262144.0f ? budget * 8 : 262144.0f;
  if (!qn) streamCredit = 0;
  else if (streamCredit > creditCap) streamCredit = creditCap;
  for (u32 scanned = 0; residentBytes > residentCap && scanned < GG; scanned++) {
    u32 c = clockHand; clockHand = (clockHand + 1) % GG;
    if (resident[c] && frame - lastUsed[c] > 90) {
      resident[c] = 0;
      residentBytes -= (float)(cellStart[c + 1] - cellStart[c]) * D * 4;
    }
  }

  // D. Fovea: full-D work on the few points actually being looked at.
  float fullBytes = 0;
  if ((flags & 2) && fcount >= 16) {
    float m[DMAX];
    for (u32 d = 0; d < D; d++) m[d] = 0;
    for (u32 f = 0; f < fcount; f++) { const float *x = X + fidx[f] * D; for (u32 d = 0; d < D; d++) m[d] += x[d]; }
    float invn = 1.0f / fcount;
    for (u32 d = 0; d < D; d++) m[d] *= invn;
    if (!lpcInit) { for (u32 d = 0; d < 2 * D; d++) lpc[d] = gpc[d]; lpcInit = 1; }
    // Subspace iteration on the fovea's own points, warm-started from last frame.
    float w1[DMAX], w2[DMAX];
    const int iters = 2;
    for (int it = 0; it < iters; it++) {
      for (u32 d = 0; d < D; d++) { w1[d] = 0; w2[d] = 0; }
      for (u32 f = 0; f < fcount; f++) {
        const float *x = X + fidx[f] * D;
        float a1 = 0, a2 = 0;
        for (u32 d = 0; d < D; d++) { float y = x[d] - m[d]; a1 += y * lpc[d]; a2 += y * lpc[D + d]; }
        for (u32 d = 0; d < D; d++) { float y = x[d] - m[d]; w1[d] += a1 * y; w2[d] += a2 * y; }
      }
      float n1 = 0;
      for (u32 d = 0; d < D; d++) n1 += w1[d] * w1[d];
      n1 = 1.0f / fsqrt(n1 + 1e-20f);
      float dp = 0;
      for (u32 d = 0; d < D; d++) { w1[d] *= n1; dp += w1[d] * w2[d]; }
      float n2 = 0;
      for (u32 d = 0; d < D; d++) { w2[d] -= dp * w1[d]; n2 += w2[d] * w2[d]; }
      n2 = 1.0f / fsqrt(n2 + 1e-20f);
      for (u32 d = 0; d < D; d++) { lpc[d] = w1[d]; lpc[D + d] = w2[d] * n2; }
    }
    float v1 = 0;
    for (u32 f = 0; f < fcount; f++) {
      const float *x = X + fidx[f] * D;
      float a1 = 0, a2 = 0;
      for (u32 d = 0; d < D; d++) { float y = x[d] - m[d]; a1 += y * lpc[d]; a2 += y * lpc[D + d]; }
      fdisp[2 * f] = a1; fdisp[2 * f + 1] = a2;
      v1 += a1 * a1;
    }
    fullBytes = (float)fcount * D * 4 * (iters + 2);
    float sd = fsqrt(v1 * invn) + 1e-6f;
    float k = r0 * 0.8f / (2.6f * sd);
    lensK = lensK <= 0 ? k : lensK * 0.85f + k * 0.15f;
    const float R = r0 * 0.94f, R0 = R * 0.7f, R1 = R - R0;
    for (u32 f = 0; f < fcount; f++) {
      float lx = fdisp[2 * f] * lensK, ly = fdisp[2 * f + 1] * lensK;
      float len = fsqrt(lx * lx + ly * ly);
      if (len > R0) {
        float t = (len - R0) / R1;
        float nl = R0 + R1 * (t / (1.0f + t));
        lx *= nl / len; ly *= nl / len;
      }
      fdisp[2 * f] = floc[2 * f] + (gx + lx - floc[2 * f]) * lensMix;
      fdisp[2 * f + 1] = floc[2 * f + 1] + (gy + ly - floc[2 * f + 1]) * lensMix;
    }
  } else {
    for (u32 f = 0; f < 2 * fcount; f++) fdisp[f] = floc[f];
    fullBytes = 0;
  }
  const int big = scale > 9000.0f;
  for (u32 f = 0; f < fcount; f++) {
    float sx = fdisp[2 * f], sy = fdisp[2 * f + 1];
    disc(sx, sy, pal + LAB[fidx[f]] * 3, big);
    float dx = sx - gx, dy = sy - gy, d2 = dx * dx + dy * dy;
    if (d2 < nearestD) { nearestD = d2; focus = (int)fidx[f]; }
  }

  stats[0] = touched; stats[1] = (float)fcount; stats[2] = paraDrawn; stats[3] = fullBytes;
  stats[4] = loaded; stats[5] = residentBytes; stats[7] = focus >= 0 ? (float)focus : -1.0f;
  stats[8] = (float)qn;
}

// True nearest neighbours in the full D-dim space (brute force, all N).
EXPORT u32 knn(u32 q, u32 k) {
  if (k > KMAX) k = KMAX;
  const u32 D = D_;
  float qv[DMAX];
  for (u32 d = 0; d < D; d++) qv[d] = X[q * D + d];
  for (u32 j = 0; j < k; j++) { knnDist[j] = 1e30f; knnIdx[j] = 0; }
  float worst = 1e30f;
  for (u32 i = 0; i < N_; i++) {
    const float *x = X + i * D;
    float s = 0;
    for (u32 d = 0; d < D; d++) { float t = x[d] - qv[d]; s += t * t; }
    if (s < worst && i != q) {
      int j = (int)k - 1;
      while (j > 0 && knnDist[j - 1] > s) { knnDist[j] = knnDist[j - 1]; knnIdx[j] = knnIdx[j - 1]; j--; }
      knnDist[j] = s; knnIdx[j] = i;
      worst = knnDist[k - 1];
    }
  }
  return k;
}

// "Decoder": latent vector -> 32x32 image. Only ever called for foveal points.
EXPORT u32 decode(u32 idx) {
  const u32 D = D_, TT = T * T;
  float y[DMAX];
  for (u32 d = 0; d < D; d++) y[d] = X[idx * D + d] - gmean[d];
  for (u32 p = 0; p < TT; p++) {
    float r = 0, g = 0, b = 0;
    for (u32 d = 0; d < D; d++) {
      float yd = y[d];
      r += yd * basis[d * TT + p];
      g += yd * basis[((d * 7 + 3) % D) * TT + p];
      b += yd * basis[((d * 13 + 5) % D) * TT + p];
    }
    r *= 0.11f; g *= 0.11f; b *= 0.11f;
    thumb[p * 4] = (u8)(127.5f + 127.0f * r / (1.0f + fabsf_(r)));
    thumb[p * 4 + 1] = (u8)(127.5f + 127.0f * g / (1.0f + fabsf_(g)));
    thumb[p * 4 + 2] = (u8)(127.5f + 127.0f * b / (1.0f + fabsf_(b)));
    thumb[p * 4 + 3] = 255;
  }
  return idx;
}
