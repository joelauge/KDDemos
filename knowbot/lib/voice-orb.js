// KnowBot voice orb: one <canvas> that shows a voice session "hearing" and "speaking", driven by real audio levels.
// Plain ES module, no dependencies. Used by voice mode (lib/voice-mode.js) in the Homepage search overlay and in web
// chat, and by the Studio's colour picker preview.
//
//   import { createOrb, createMeter, ORB_PRESETS } from './voice-orb.js';
//   const orb = createOrb(canvas, { preset: 'ocean' });
//   orb.setState('listening');                  // 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking'
//   orb.setLevelSource(createMeter(analyser));   // called once per frame: a number 0..1 or {level, bands:[low,mid,high]}
//   orb.setPreset('sunset'); orb.stats(); orb.destroy();
//
// Performance: one requestAnimationFrame loop per orb; no DOM writes, layout reads or allocations per frame (the canvas
// is resized from a ResizeObserver, the meter reads into preallocated arrays). WebGL draws two things: the glow (one
// full-canvas triangle, a soft halo) and the orb itself as a dense cloud of tiny particles on a sphere (one static vertex
// buffer; every particle's displacement, depth shading and colour is computed in the vertex shader from 3D noise driven by
// the voice level and bands, so the CPU uploads only a few uniforms per frame). Without WebGL it falls back to Canvas2D
// (the same particle sphere, fewer particles). The loop stops while the canvas is off screen or the tab is hidden.
// The level is smoothed with a fast attack and a slower release, so it reacts at once to a voice and never jitters.
// prefers-reduced-motion: no surface motion, only a gentle size pulse with the level.

/** Colour presets the bot owner picks from (KnowBot Studio → Homepage search; the same choice applies to web chat). */
export const ORB_PRESETS = Object.freeze({
  ocean: Object.freeze({ label: 'Ocean', colors: ['#38bdf8', '#1d4ed8', '#a5f3fc'] }),
  violet: Object.freeze({ label: 'Violet', colors: ['#a855f7', '#5b21b6', '#f5d0fe'] }),
  sunset: Object.freeze({ label: 'Sunset', colors: ['#fb923c', '#be123c', '#fde68a'] }),
  mint: Object.freeze({ label: 'Mint', colors: ['#34d399', '#0f766e', '#d9f99d'] }),
  ruby: Object.freeze({ label: 'Ruby', colors: ['#ef4444', '#7f1d1d', '#fecaca'] }),
  midnight: Object.freeze({ label: 'Midnight', colors: ['#2546c4', '#0a1238', '#7d9bff'] }),
  // monochrome: silver particles over near-black depth, a white highlight
  silver: Object.freeze({ label: 'Silver', colors: ['#c3c7d0', '#16171b', '#ffffff'] }),
});
export const ORB_IDS = Object.freeze(Object.keys(ORB_PRESETS));
export const ORB_DEFAULT = 'ocean';
/** A saved value → a known preset id (unknown or missing: the default). */
export const orbId = (v) => (ORB_IDS.includes(v) ? v : ORB_DEFAULT);
/** A static CSS swatch of a preset (for pickers and buttons): a lit sphere in its colours. */
export function orbSwatch(id) {
  const [a, b, c] = ORB_PRESETS[orbId(id)].colors;
  return `radial-gradient(circle at 34% 30%, ${c} 0%, ${a} 38%, ${b} 100%)`;
}

const STATES = ['idle', 'connecting', 'listening', 'thinking', 'speaking'];
const ATTACK = 0.025, RELEASE = 0.16;   // seconds: level smoothing (fast up, slower down)
const EASE = 0.14;                      // seconds: state parameters glide between states
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/**
 * An audio meter over an AnalyserNode: () => {level, bands:[low, mid, high]} (0..1), the same object every call.
 * Level is the RMS in dB mapped from -58 dB (silence) to -12 dB (a loud voice).
 */
export function createMeter(analyser) {
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.45;
  const td = new Float32Array(analyser.fftSize);
  const fd = new Uint8Array(analyser.frequencyBinCount);
  const hz = (analyser.context?.sampleRate || 48000) / analyser.fftSize;
  const range = (lo, hi) => [Math.max(1, Math.floor(lo / hz)), Math.min(fd.length - 1, Math.ceil(hi / hz))];
  const R = [range(80, 400), range(400, 2000), range(2000, 6000)];
  const out = { level: 0, bands: [0, 0, 0] };
  return function read() {
    analyser.getFloatTimeDomainData(td);
    let s = 0;
    for (let i = 0; i < td.length; i++) s += td[i] * td[i];
    const db = 20 * Math.log10(Math.sqrt(s / td.length) + 1e-9);
    out.level = clamp01((db + 58) / 46);
    analyser.getByteFrequencyData(fd);
    for (let b = 0; b < 3; b++) {
      const [lo, hi] = R[b];
      let m = 0;
      for (let i = lo; i <= hi; i++) m += fd[i];
      out.bands[b] = m / ((hi - lo + 1) * 255);
    }
    return out;
  };
}

// ------------------------------------------------------------------------------------------------ WebGL renderer
// the halo behind the particles: a soft glow that breathes with the level
const GLOW_VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';
const GLOW_FRAG = `precision mediump float;
uniform vec2 uRes;uniform float uLevel;uniform vec3 uA;uniform vec3 uC;uniform float uGlow;uniform float uScale;
void main(){
  float half_=0.5*min(uRes.x,uRes.y);
  vec2 p=(gl_FragCoord.xy-0.5*uRes)/half_;
  float len=length(p);
  float R=0.6*uScale;
  float core=exp(-len*len/(R*R*0.55))*(0.10+0.16*uGlow);
  float halo=exp(-max(len-R*0.82,0.0)*(7.5-3.5*uGlow))*(0.16+0.5*uGlow);
  float fade=1.0-smoothstep(0.8,1.0,len);
  vec3 gc=mix(uA,uC,0.35);
  float a=clamp((core+halo)*fade,0.0,1.0);
  gl_FragColor=vec4(gc*a,a);
}`;
// the orb: N particles on a sphere (Fibonacci lattice), rotated, displaced by noise and drawn as soft round dots
const DOT_VERT = `precision highp float;
attribute vec3 aPos;attribute float aSeed;
uniform vec2 uRes;uniform float uTime;uniform float uLevel;uniform vec3 uBands;
uniform vec3 uA;uniform vec3 uB;uniform vec3 uC;
uniform float uAmp;uniform float uScale;uniform float uThink;uniform float uDot;
varying vec3 vCol;varying float vAlpha;
vec3 m289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 m289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 perm(vec4 x){return m289(((x*34.0)+1.0)*x);}
vec4 tis(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=m289(i);
  vec4 p=perm(perm(perm(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 nr=tis(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=nr.x;p1*=nr.y;p2*=nr.z;p3*=nr.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
void main(){
  float t=uTime;
  // slow rotation (faster while thinking)
  float ry=t*0.35+uThink*t*0.6;float rx=0.35+0.15*sin(t*0.21);
  float cy=cos(ry),sy=sin(ry),cx=cos(rx),sx=sin(rx);
  vec3 q=aPos;
  q=vec3(cy*q.x+sy*q.z,q.y,-sy*q.x+cy*q.z);
  q=vec3(q.x,cx*q.y-sx*q.z,sx*q.y+cx*q.z);
  // the surface: three octaves of noise; the voice bands push the finer ones
  float n1=snoise(aPos*1.25+vec3(0.0,0.0,t*0.42));
  float n2=snoise(aPos*2.6+vec3(3.1,0.0,t*0.75))*(0.55+uBands.y);
  float n3=snoise(aPos*5.0+vec3(-1.7,2.0,t*1.1))*(0.35+uBands.z);
  float disp=uAmp*(0.62*n1+0.28*n2+0.12*n3);
  // a little scatter per particle so the shell has depth, more when loud
  float jit=(aSeed-0.5)*(0.035+0.06*uLevel);
  float r=0.6*uScale*(1.0+disp*0.09+jit);
  vec3 w=q*r;
  float half_=0.5*min(uRes.x,uRes.y);
  vec2 xy=w.xy*half_/(0.5*uRes);
  gl_Position=vec4(xy,-w.z*0.5,1.0);
  float front=q.z*0.5+0.5;            // 0 back .. 1 front
  gl_PointSize=uDot*(0.7+0.75*front)*(1.0+0.35*uLevel);
  // colour: deep at the back, bright at the front; noise and the voice bring in the highlight colour
  float f=snoise(aPos*0.9+vec3(5.2,1.3,t*0.16))*0.5+0.5;
  vec3 col=mix(uB,uA,smoothstep(0.15,0.9,front*0.7+f*0.5));
  float ang=atan(q.y,q.x);
  float sweep=pow(0.5+0.5*sin(ang*2.0-t*3.2+q.z*1.5),8.0)*uThink;
  col=mix(col,uC,clamp(smoothstep(0.55,1.0,f)*(0.25+0.6*uLevel)+max(disp,0.0)*0.35+sweep*0.8,0.0,1.0));
  vCol=col;
  vAlpha=(0.22+0.78*front)*(0.85+0.15*aSeed);
}`;
const DOT_FRAG = `precision mediump float;
varying vec3 vCol;varying float vAlpha;
void main(){
  vec2 c=gl_PointCoord-0.5;
  float d=dot(c,c)*4.0;                 // 0 centre .. 1 edge
  float a=(1.0-smoothstep(0.35,1.0,d))*vAlpha;
  if(a<0.01)discard;
  gl_FragColor=vec4(vCol*a,a);
}`;

/** Points on a sphere (Fibonacci lattice) + a per-point seed. */
function spherePoints(n) {
  const pos = new Float32Array(n * 3), seed = new Float32Array(n);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n, rr = Math.sqrt(1 - y * y), th = ga * i;
    pos[i * 3] = Math.cos(th) * rr; pos[i * 3 + 1] = y; pos[i * 3 + 2] = Math.sin(th) * rr;
    seed[i] = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
  }
  return { pos, seed };
}
export const PARTICLES = 3600;

function webglRenderer(canvas) {
  let gl = null;
  try { gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' }); } catch { gl = null; }
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
  const link = (vs, fs) => {
    const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return null;
    const pr = gl.createProgram();
    gl.attachShader(pr, v); gl.attachShader(pr, f); gl.linkProgram(pr);
    return gl.getProgramParameter(pr, gl.LINK_STATUS) ? pr : null;
  };
  let G = null, D = null, maxPt = 64;
  function init() {
    const gp = link(GLOW_VERT, GLOW_FRAG), dp = link(DOT_VERT, DOT_FRAG);
    if (!gp || !dp) return false;
    const tri = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tri);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    G = { prog: gp, buf: tri, loc: gl.getAttribLocation(gp, 'p'), U: {} };
    for (const n of ['uRes', 'uLevel', 'uA', 'uC', 'uGlow', 'uScale']) G.U[n] = gl.getUniformLocation(gp, n);
    const { pos, seed } = spherePoints(PARTICLES);
    const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    const sb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, sb); gl.bufferData(gl.ARRAY_BUFFER, seed, gl.STATIC_DRAW);
    D = { prog: dp, pb, sb, lp: gl.getAttribLocation(dp, 'aPos'), ls: gl.getAttribLocation(dp, 'aSeed'), U: {} };
    for (const n of ['uRes', 'uTime', 'uLevel', 'uBands', 'uA', 'uB', 'uC', 'uAmp', 'uScale', 'uThink', 'uDot']) D.U[n] = gl.getUniformLocation(dp, n);
    maxPt = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || [1, 64])[1] || 64;
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied
    return true;
  }
  if (!init()) return null;
  let lost = false;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  canvas.addEventListener('webglcontextrestored', () => { lost = !init(); });
  return {
    kind: 'webgl',
    draw(s) {
      if (lost) return;
      const w = canvas.width, h = canvas.height;
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // glow
      gl.useProgram(G.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, G.buf);
      gl.enableVertexAttribArray(G.loc); gl.vertexAttribPointer(G.loc, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(G.U.uRes, w, h); gl.uniform1f(G.U.uLevel, s.level);
      gl.uniform3fv(G.U.uA, s.colors[0]); gl.uniform3fv(G.U.uC, s.colors[2]);
      gl.uniform1f(G.U.uGlow, s.glow); gl.uniform1f(G.U.uScale, s.scale);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disableVertexAttribArray(G.loc);
      // particles
      gl.useProgram(D.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, D.pb); gl.enableVertexAttribArray(D.lp); gl.vertexAttribPointer(D.lp, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, D.sb); gl.enableVertexAttribArray(D.ls); gl.vertexAttribPointer(D.ls, 1, gl.FLOAT, false, 0, 0);
      gl.uniform2f(D.U.uRes, w, h);
      gl.uniform1f(D.U.uTime, s.phase); gl.uniform1f(D.U.uLevel, s.level);
      gl.uniform3f(D.U.uBands, s.bands[0], s.bands[1], s.bands[2]);
      gl.uniform3fv(D.U.uA, s.colors[0]); gl.uniform3fv(D.U.uB, s.colors[1]); gl.uniform3fv(D.U.uC, s.colors[2]);
      gl.uniform1f(D.U.uAmp, s.amp); gl.uniform1f(D.U.uScale, s.scale); gl.uniform1f(D.U.uThink, s.think);
      // dot size follows the orb's size on screen: tiny, close together
      gl.uniform1f(D.U.uDot, Math.min(maxPt, Math.max(1.4, Math.min(w, h) * 0.0085)));
      gl.drawArrays(gl.POINTS, 0, PARTICLES);
      gl.disableVertexAttribArray(D.lp); gl.disableVertexAttribArray(D.ls);
    },
    destroy() { try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore */ } },
  };
}

// ------------------------------------------------------------------------------------------------ Canvas2D fallback
function canvas2dRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const css = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
  const N = 700;
  const { pos, seed } = spherePoints(N);
  return {
    kind: '2d',
    draw(s) {
      const w = canvas.width, hgt = canvas.height, half = Math.min(w, hgt) / 2, cx = w / 2, cy = hgt / 2;
      ctx.clearRect(0, 0, w, hgt);
      const R = half * 0.6 * s.scale;
      const glow = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, half);
      glow.addColorStop(0, css(s.colors[0], 0.16 + 0.4 * s.glow));
      glow.addColorStop(1, css(s.colors[0], 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, hgt);
      const t = s.phase, ry = t * 0.35, cyy = Math.cos(ry), syy = Math.sin(ry), k = 0.09 * s.amp;
      const dot = Math.max(1, half * 0.02);
      for (let i = 0; i < N; i++) {
        const x0 = pos[i * 3], y0 = pos[i * 3 + 1], z0 = pos[i * 3 + 2];
        const x = cyy * x0 + syy * z0, z = -syy * x0 + cyy * z0;
        const d = Math.sin(3 * x0 + t * 1.3) + 0.6 * Math.sin(5 * y0 - t * 1.7) + 0.4 * Math.sin(2 * z0 + t * 0.9);
        const r = R * (1 + k * d + (seed[i] - 0.5) * 0.04);
        const front = z * 0.5 + 0.5;
        ctx.fillStyle = css(front > 0.55 ? s.colors[0] : s.colors[1], 0.25 + 0.75 * front);
        const sz = dot * (0.7 + 0.7 * front) * (1 + 0.35 * s.level);   // dots swell with the voice, as in WebGL
        ctx.fillRect(cx + x * r - sz / 2, cy - y0 * r - sz / 2, sz, sz);
      }
    },
    destroy() {},
  };
}

// ------------------------------------------------------------------------------------------------ the orb
/**
 * @param {HTMLCanvasElement} canvas  sized by CSS; the drawing buffer follows its box (device pixels, capped)
 * @param {object} [o]
 * @param {string} [o.preset]          an ORB_PRESETS id
 * @param {'webgl'|'2d'} [o.renderer]  force a renderer (tests); default WebGL, else Canvas2D
 * @param {boolean} [o.reducedMotion]  default: the prefers-reduced-motion setting
 * @param {number} [o.maxPixels]       cap of the drawing buffer's longer side (default 512)
 */
export function createOrb(canvas, o = {}) {
  const mq = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)'); } catch { return null; } })();
  let reduced = o.reducedMotion ?? !!mq?.matches;
  const onMq = () => { if (o.reducedMotion == null) reduced = !!mq.matches; };
  mq?.addEventListener?.('change', onMq);
  const r = (o.renderer !== '2d' && webglRenderer(canvas)) || canvas2dRenderer(canvas);
  const maxPx = o.maxPixels || 512;
  let preset = orbId(o.preset);
  const s = {
    phase: Math.random() * 50, level: 0, bands: [0, 0, 0], colors: ORB_PRESETS[preset].colors.map(rgbOf),
    amp: 0.3, glow: 0.3, scale: 0.94, think: 0,
  };
  let state = 'idle', source = null, raf = 0, last = 0, destroyed = false, inView = true, docVisible = !document.hidden, clock = 0;
  const st = { frames: 0, total: 0, max: 0, ring: new Float32Array(120), i: 0 };

  function resize() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = Math.max(1, Math.round(box.width * dpr)), hh = Math.max(1, Math.round(box.height * dpr));
    const k = Math.min(1, maxPx / Math.max(w, hh));
    w = Math.max(1, Math.round(w * k)); hh = Math.max(1, Math.round(hh * k));
    if (canvas.width !== w || canvas.height !== hh) { canvas.width = w; canvas.height = hh; if (!raf) draw(); }
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => { inView = es[es.length - 1].isIntersecting; sync(); }) : null;
  io?.observe(canvas);
  const onVis = () => { docVisible = !document.hidden; sync(); };
  document.addEventListener('visibilitychange', onVis);

  const ease = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
  function step(dt) {
    let target = 0, bands = null;
    if (source && (state === 'listening' || state === 'speaking')) {
      let v = 0;
      try { v = source(); } catch { v = 0; }
      if (typeof v === 'number') target = v; else if (v) { target = v.level || 0; bands = v.bands || null; }
    }
    target = clamp01(target);
    s.level = ease(s.level, target, dt, target > s.level ? ATTACK : RELEASE);
    for (let b = 0; b < 3; b++) s.bands[b] = ease(s.bands[b], bands ? clamp01(bands[b]) : s.level * 0.6, dt, 0.08);
    clock += dt;
    const L = s.level;
    let amp, glow, scale, think, speed;
    if (reduced) {
      amp = 0.12; glow = 0.3 + 0.3 * L; scale = 0.94 + 0.06 * L; think = 0; speed = 0.12;
    } else if (state === 'listening') { amp = 0.45 + 2.0 * L; glow = 0.35 + 0.65 * L; scale = 0.95 + 0.12 * L; think = 0; speed = 0.9 + 1.2 * L; }
    else if (state === 'speaking') { amp = 0.5 + 2.2 * L; glow = 0.45 + 0.55 * L; scale = 0.96 + 0.13 * L; think = 0; speed = 1.1 + 1.4 * L; }
    else if (state === 'thinking') { amp = 0.55; glow = 0.5; scale = 0.92 + 0.02 * Math.sin(clock * 3); think = 1; speed = 2.4; }
    else if (state === 'connecting') { amp = 0.35; glow = 0.3; scale = 0.9 + 0.02 * Math.sin(clock * 2.2); think = 0.5; speed = 1.3; }
    else { amp = 0.3; glow = 0.25; scale = 0.92 + 0.015 * Math.sin(clock * 1.4); think = 0; speed = 0.55; }
    s.amp = ease(s.amp, amp, dt, EASE); s.glow = ease(s.glow, glow, dt, EASE); s.think = ease(s.think, think, dt, EASE * 2);
    s.scale = reduced || state === 'listening' || state === 'speaking' ? ease(s.scale, scale, dt, 0.05) : ease(s.scale, scale, dt, EASE);
    s.phase += dt * speed; // integrated, so a change of speed never jumps the surface
  }
  function draw() { if (!destroyed && r && canvas.width > 1) r.draw(s); }
  function frame(now) {
    raf = 0;
    if (destroyed || !inView || !docVisible) return;
    const t0 = performance.now();
    const dt = last ? Math.min(0.05, Math.max(0, (now - last) / 1000)) : 1 / 60;
    last = now;
    step(dt);
    draw();
    const cost = performance.now() - t0;
    st.frames++; st.total += cost; if (cost > st.max) st.max = cost;
    st.ring[st.i++ % st.ring.length] = cost;
    raf = requestAnimationFrame(frame);
  }
  function sync() {
    const run = !destroyed && inView && docVisible;
    if (run && !raf) { last = 0; raf = requestAnimationFrame(frame); }
    else if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  resize();
  sync();

  const api = {
    get renderer() { return r ? r.kind : 'none'; },
    get state() { return state; },
    get level() { return s.level; },
    get running() { return !!raf; },
    setState(next) { if (STATES.includes(next)) state = next; },
    /** fn: () => number | {level, bands}; null stops reacting (level glides to 0). */
    setLevelSource(fn) { source = typeof fn === 'function' ? fn : null; },
    setPreset(id) { preset = orbId(id); s.colors = ORB_PRESETS[preset].colors.map(rgbOf); if (!raf) draw(); },
    get preset() { return preset; },
    setReducedMotion(v) { o.reducedMotion = v; reduced = v == null ? !!mq?.matches : !!v; },
    /** Frame cost of the orb's own work (JS + draw calls), in ms. */
    stats() {
      const n = Math.min(st.frames, st.ring.length);
      const recent = n ? [...st.ring.slice(0, n)].sort((a, b) => a - b) : [];
      return { renderer: api.renderer, frames: st.frames, avgMs: st.frames ? st.total / st.frames : 0, maxMs: st.max, p95Ms: recent.length ? recent[Math.floor(recent.length * 0.95)] : 0, running: !!raf };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro?.disconnect(); io?.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      mq?.removeEventListener?.('change', onMq);
      r?.destroy();
      source = null;
      if (canvas.kbOrb === api) delete canvas.kbOrb;
    },
  };
  canvas.kbOrb = api; // tests and tools reach the orb from its element (never a global)
  return api;
}
