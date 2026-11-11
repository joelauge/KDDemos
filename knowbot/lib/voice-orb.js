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
// is resized from a ResizeObserver, the meter reads into preallocated arrays). WebGL draws one full-canvas triangle with a
// small fragment shader (a soft glowing sphere whose surface is displaced by 3D noise); without WebGL it falls back to
// Canvas2D (a smooth blob with two gradients). The loop stops while the canvas is off screen or the tab is hidden.
// The level is smoothed with a fast attack and a slower release, so it reacts at once to a voice and never jitters.
// prefers-reduced-motion: no surface motion, only a gentle size pulse with the level.

/** Colour presets the bot owner picks from (KnowBot Studio → Homepage search; the same choice applies to web chat). */
export const ORB_PRESETS = Object.freeze({
  ocean: Object.freeze({ label: 'Ocean', colors: ['#38bdf8', '#1d4ed8', '#a5f3fc'] }),
  violet: Object.freeze({ label: 'Violet', colors: ['#a855f7', '#5b21b6', '#f5d0fe'] }),
  sunset: Object.freeze({ label: 'Sunset', colors: ['#fb923c', '#be123c', '#fde68a'] }),
  mint: Object.freeze({ label: 'Mint', colors: ['#34d399', '#0f766e', '#d9f99d'] }),
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
const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';
const FRAG = `precision mediump float;
uniform vec2 uRes;uniform float uTime;uniform float uLevel;uniform vec3 uBands;
uniform vec3 uA;uniform vec3 uB;uniform vec3 uC;
uniform float uAmp;uniform float uGlow;uniform float uScale;uniform float uThink;
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
  float half_=0.5*min(uRes.x,uRes.y);
  vec2 p=(gl_FragCoord.xy-0.5*uRes)/half_;
  float len=length(p);
  vec2 dir=len>0.0001?p/len:vec2(1.0,0.0);
  float t=uTime;
  float n1=snoise(vec3(dir*1.1,t*0.33));
  float n2=snoise(vec3(dir*2.4+3.1,t*0.61));
  float n3=snoise(vec3(dir*4.2-1.7,t*0.9));
  float disp=uAmp*(0.62*n1+0.28*n2*(0.6+uBands.y)+0.1*n3*(0.4+uBands.z));
  float R=0.6*uScale+disp*0.06;
  float d=len-R;
  float aa=1.6/half_;
  float inside=1.0-smoothstep(-aa,aa,d);
  float rr=clamp(len/max(R,0.001),0.0,1.0);
  float z=sqrt(max(0.0,1.0-rr*rr));
  vec3 nrm=vec3(p/max(R,0.001),z);
  vec3 q=vec3(nrm.xy*0.85,t*0.16);
  float f=snoise(q)*0.5+0.5;
  float g=snoise(q*1.5+vec3(5.2,1.3,t*0.13))*0.5+0.5;
  vec3 col=mix(uB,uA,smoothstep(0.0,1.0,f));
  col=mix(col,uC,smoothstep(0.45,1.05,g)*(0.35+0.4*uLevel));
  vec3 L=normalize(vec3(-0.45,0.55,0.75));
  float diff=clamp(dot(nrm,L),0.0,1.0);
  float spec=pow(clamp(dot(reflect(-L,nrm),vec3(0.0,0.0,1.0)),0.0,1.0),22.0);
  float rim=pow(1.0-z,2.4);
  float ang=atan(p.y,p.x);
  float sweep=pow(0.5+0.5*sin(ang*2.0-t*3.2+nrm.y*1.5),8.0)*uThink;
  col=col*(0.58+0.52*diff)+vec3(spec*0.38)+rim*uC*(0.3+0.7*uLevel)+uC*sweep*0.45*rim*2.0;
  float fade=1.0-smoothstep(0.78,1.0,len);
  float glow=exp(-max(d,0.0)*(9.0-4.0*uGlow))*(0.22+0.6*uGlow)*(1.0-inside)*fade;
  vec3 gc=mix(uA,uC,0.35);
  gl_FragColor=vec4(col*inside+gc*glow,clamp(inside+glow,0.0,1.0));
}`;

function webglRenderer(canvas) {
  let gl = null;
  try { gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' }); } catch { gl = null; }
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
  let prog = null, U = null;
  function init() {
    const v = sh(gl.VERTEX_SHADER, VERT), f = sh(gl.FRAGMENT_SHADER, FRAG);
    if (!v || !f) return false;
    prog = gl.createProgram();
    gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    U = {};
    for (const n of ['uRes', 'uTime', 'uLevel', 'uBands', 'uA', 'uB', 'uC', 'uAmp', 'uGlow', 'uScale', 'uThink']) U[n] = gl.getUniformLocation(prog, n);
    gl.clearColor(0, 0, 0, 0);
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
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      gl.uniform1f(U.uTime, s.phase);
      gl.uniform1f(U.uLevel, s.level);
      gl.uniform3f(U.uBands, s.bands[0], s.bands[1], s.bands[2]);
      gl.uniform3fv(U.uA, s.colors[0]); gl.uniform3fv(U.uB, s.colors[1]); gl.uniform3fv(U.uC, s.colors[2]);
      gl.uniform1f(U.uAmp, s.amp); gl.uniform1f(U.uGlow, s.glow); gl.uniform1f(U.uScale, s.scale); gl.uniform1f(U.uThink, s.think);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() { try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore */ } },
  };
}

// ------------------------------------------------------------------------------------------------ Canvas2D fallback
function canvas2dRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const css = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
  const N = 72;
  return {
    kind: '2d',
    draw(s) {
      const w = canvas.width, hgt = canvas.height, half = Math.min(w, hgt) / 2, cx = w / 2, cy = hgt / 2;
      ctx.clearRect(0, 0, w, hgt);
      const R = half * 0.6 * s.scale;
      const glow = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, half);
      glow.addColorStop(0, css(s.colors[0], 0.22 + 0.5 * s.glow));
      glow.addColorStop(1, css(s.colors[0], 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, hgt);
      ctx.beginPath();
      const k = 0.05 * s.amp, t = s.phase;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        const r = R * (1 + k * (Math.sin(3 * a + t * 1.3) + 0.6 * Math.sin(5 * a - t * 1.7) + 0.4 * Math.sin(2 * a + t * 0.9)));
        const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      const fill = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R * 1.05);
      fill.addColorStop(0, css(s.colors[2]));
      fill.addColorStop(0.45, css(s.colors[0]));
      fill.addColorStop(1, css(s.colors[1]));
      ctx.fillStyle = fill;
      ctx.fill();
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
