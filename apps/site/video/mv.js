// beat-video engine. Every pixel is a function of song time t (seconds); scenes are pinned to the track's bars.
// Load after beats.js (window.BEATS). Pages take their size from ?w=&h= (the scripts add it) or window.FORMAT.
//   ?record     the renderer drives window.seek(t); nothing plays
//   ?t=<s>      start the preview there        ?debug   show time, bar and beat
// Preview: open index.html in a browser and click to play with the music; space pauses, ←/→ move a bar.
const MV = (() => {
  const q = new URLSearchParams(location.search);
  const [fw, fh] = (window.FORMAT || "1920x1080").split("x").map(Number);
  const W = Number(q.get("w")) || fw, H = Number(q.get("h")) || fh;
  const shape = W / H > 1.2 ? "land" : W / H < 0.9 ? "tall" : "square";
  document.documentElement.style.setProperty("--W", W + "px");
  document.documentElement.style.setProperty("--H", H + "px");

  const clamp = (x) => Math.max(0, Math.min(1, x));
  const p = (t, a, b) => clamp((t - a) / (b - a));
  const io = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const out = (x) => 1 - Math.pow(1 - x, 3);
  const out5 = (x) => 1 - Math.pow(1 - x, 5);
  const back = (x) => 1 + 2.4 * Math.pow(x - 1, 3) + 1.4 * Math.pow(x - 1, 2);
  const lerp = (a, b, x) => a + (b - a) * x;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ---- the grid. Beat and bar numbers may be fractional (bar(7.5) is half way through bar 7).
  const G = () => window.BEATS;
  function beat(i) {
    const g = G(), n = g.beats.length, k = Math.floor(i), f = i - k;
    const at = (j) => (j < 0 ? g.beats[0] + j * g.period : j >= n ? g.beats[n - 1] + (j - n + 1) * g.period : g.beats[j]);
    return at(k) + f * g.period;
  }
  const barBeat = (i) => G().downbeatIndex + 4 * i;
  const bar = (i) => beat(barBeat(i));
  // Beat n (0–3, may be fractional) of bar i.
  const b = (i, n = 0) => beat(barBeat(i) + n);
  function beatAt(t) {
    const g = G().beats;
    if (t < g[0]) return { i: -1, since: Infinity };
    let lo = 0, hi = g.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (g[m] <= t) lo = m; else hi = m - 1; }
    return { i: lo, since: t - g[lo] };
  }
  // 1 on each beat, decaying over len seconds. pulse(t, 0.3, 4) pulses on downbeats only.
  function pulse(t, len = 0.28, every = 1) {
    const x = beatAt(t);
    if (x.i < 0 || (x.i - G().downbeatIndex) % every !== 0) return 0;
    return Math.pow(1 - clamp(x.since / len), 2);
  }

  // ---- motion helpers. All take the time t and absolute start/end times.
  function show(el, t, a, z = Infinity, dy = 28, dur = 0.4) {
    const i = out(p(t, a, a + dur)), o = z === Infinity ? 1 : 1 - p(t, z - 0.18, z);
    el.style.opacity = Math.min(i, o);
    el.style.transform = `translateY(${(1 - i) * dy}px)`;
  }
  function slam(el, t, a, z = Infinity, from = 1.35) {
    const i = out5(p(t, a, a + 0.22)), o = z === Infinity ? 1 : 1 - p(t, z - 0.15, z);
    el.style.opacity = Math.min(i, o);
    el.style.transform = `scale(${lerp(from, 1, i)})`;
  }
  // Appear at a (hidden before it, so flex lists reflow as items arrive).
  function pop(el, t, a, dy = 12, dur = 0.25) {
    const i = out(p(t, a, a + dur));
    el.style.display = t < a ? "none" : "";
    el.style.opacity = i;
    el.style.transform = `translateY(${(1 - i) * dy}px)`;
  }
  function type(el, text, t, a, z) { el.textContent = text.slice(0, Math.round(text.length * p(t, a, z))); }
  // Steps through values on given times: count(el, t, [[time, value], ...], fmt). Rolls between steps over 0.2s.
  function count(el, t, steps, fmt = (v) => Math.round(v)) {
    let v = steps[0][1];
    for (let i = 1; i < steps.length; i++) if (t >= steps[i][0]) v = lerp(steps[i - 1][1], steps[i][1], out(p(t, steps[i][0], steps[i][0] + 0.2)));
    el.textContent = fmt(v);
  }

  // Camera over an element (e.g. a 1280×800 app) inside a viewport vw × vh: keys [[t, x, y, scale], ...],
  // (x, y) = the point of el centred in the viewport.
  function camera(el, vw, vh, keys) {
    el.style.transformOrigin = "0 0";
    const state = (t) => {
      let [, x, y, s] = keys[0];
      for (let i = 0; i < keys.length - 1; i++) {
        const [a, ax, ay, as] = keys[i], [z, bx, by, bs] = keys[i + 1];
        if (t > z) { x = bx; y = by; s = bs; continue; }
        if (t >= a) { const e = io(p(t, a, z)); x = lerp(ax, bx, e); y = lerp(ay, by, e); s = Math.exp(lerp(Math.log(as), Math.log(bs), e)); }
      }
      return { x, y, s };
    };
    const f = (t) => { const { x, y, s } = state(t); el.style.transform = `translate(${vw / 2 - x * s}px, ${vh / 2 - y * s}px) scale(${s})`; };
    f.el = el;
    // Where a point of el (in its own, untransformed coordinates) appears in the viewport at time t.
    f.map = (t, px, py) => { const { x, y, s } = state(t); return [vw / 2 + (px - x) * s, vh / 2 + (py - y) * s]; };
    return f;
  }
  // Centre of el relative to host, as laid out now (after the camera has moved).
  function at(el, host) { const r = el.getBoundingClientRect(), h = host.getBoundingClientRect(); return [r.left - h.left + r.width / 2, r.top - h.top + r.height / 2]; }
  // Cursor inside host: keys [[t, x, y, click?], ...]. x may be an element (or a function returning one or [x, y]),
  // with the click flag in the y slot: [t, el, true]. With a camera (cursor(host, keys, cam), host = the camera's
  // viewport), an element inside the camera is measured in the camera element's own coordinates, which no transform
  // changes, and mapped through the camera at the key's time, so every frame is the same whichever is drawn first.
  // Targets must be laid out (not display:none) when the cursor first draws.
  function cursor(host, keys, cam) {
    const el = document.createElement("div");
    el.className = "mv-cursor";
    el.innerHTML = `<div class="ring"></div><svg viewBox="0 0 24 24" width="40" height="40"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#141413" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    host.appendChild(el);
    const ring = $(".ring", el);
    let pts = null;
    return (t) => {
      if (!pts) pts = keys.map(([kt, x, y, click]) => {
        let v = typeof x === "function" ? x() : x;
        if (v instanceof Element && cam && cam.el.contains(v)) {
          const c = cam.el.getBoundingClientRect(), r = v.getBoundingClientRect(), k = c.width / cam.el.offsetWidth;
          v = cam.map(kt, (r.left - c.left + r.width / 2) / k, (r.top - c.top + r.height / 2) / k);
        } else if (v instanceof Element) v = at(v, host);
        return Array.isArray(v) ? [kt, v[0], v[1], y === true || click] : [kt, x, y, click];
      });
      let x = pts[0][1], y = pts[0][2];
      for (let i = 0; i < pts.length - 1; i++) {
        const [a, ax, ay] = pts[i], [z, bx, by] = pts[i + 1];
        if (t >= a && t <= z) { const e = io(p(t, a, z)); x = lerp(ax, bx, e); y = lerp(ay, by, e); } else if (t > z) { x = bx; y = by; }
      }
      el.style.opacity = t < pts[0][0] || t > pts[pts.length - 1][0] + 0.3 ? 0 : 1;
      el.style.transform = `translate(${x}px, ${y}px)`;
      const c = pts.find((k) => k[3] && t >= k[0] && t < k[0] + 0.4);
      if (c) { const r = p(t, c[0], c[0] + 0.4); ring.style.opacity = 1 - r; ring.style.transform = `scale(${0.4 + r})`; } else ring.style.opacity = 0;
    };
  }

  // ---- scenes. from/to are bar numbers (fractional allowed) or {s: seconds}.
  // transition: "wipe" (default, a slab sweeping across on the downbeat), "flash", or "cut".
  const scenes = [];
  const time = (v) => (typeof v === "object" ? v.s : bar(v));
  function scene(o) { scenes.push({ transition: "wipe", ...o }); return o; }
  function transitions(t) {
    const wipe = $("#mv-wipe"), flash = $("#mv-flash");
    let w = null, f = null;
    for (const s of scenes) {
      const a = time(s.from);
      if (a < 0.5 || t < a - 0.22 || t > a + 0.3) continue;
      if (s.transition === "wipe") w = a; else if (s.transition === "flash") f = a;
    }
    if (wipe) { wipe.style.opacity = w === null ? 0 : 1; if (w !== null) wipe.style.transform = `translateX(${lerp(-110, 110, io(p(t, w - 0.22, w + 0.22)))}%) skewX(-12deg)`; }
    if (flash) flash.style.opacity = f === null ? 0 : Math.pow(1 - p(t, f, f + 0.3), 2) * (t >= f ? 1 : 0);
  }

  function run() {
    const frame = $(".mv-frame");
    frame.classList.add(shape);
    if (!$("#mv-wipe")) frame.insertAdjacentHTML("beforeend", '<div id="mv-wipe"></div><div id="mv-flash"></div>');
    const END = window.END || G().dur;
    const ctx = { beat, bar, b, barBeat, beatAt, W, H, shape };
    for (const s of scenes) s.init && s.init.call(s, ctx);
    const hud = q.has("debug") ? frame.appendChild(Object.assign(document.createElement("div"), { className: "mv-hud" })) : null;
    const draw = (t) => {
      for (const s of scenes) {
        const a = time(s.from), z = time(s.to), on = t >= a && t < z;
        s.el.style.display = on ? "" : "none";
        if (on) s.render.call(s, t, { ...ctx, a, z, l: t - a });
      }
      transitions(t);
      if (hud) { const x = beatAt(t), bi = x.i - G().downbeatIndex; hud.textContent = `${t.toFixed(2)}s · bar ${Math.floor(bi / 4)} beat ${((bi % 4) + 4) % 4}`; }
    };
    window.DURATION = END;
    window.SCENES = scenes.map((s) => ({ id: s.el.id, from: time(s.from), to: Math.min(time(s.to), END) }));
    window.seek = draw;
    const t0 = Number(q.get("t")) || 0;
    draw(t0);
    document.fonts.ready.then(() => { draw(t0); window.READY = true; });
    if (q.has("record")) return;
    const audio = new Audio(window.AUDIO || "music.mp3");
    let started = false;
    const loop = () => { draw(audio.currentTime); if (!audio.paused) requestAnimationFrame(loop); };
    document.addEventListener("click", () => { if (!started) { audio.currentTime = t0; started = true; } audio.paused ? audio.play().then(loop) : audio.pause(); });
    document.addEventListener("keydown", (e) => {
      if (e.code === "Space") { e.preventDefault(); audio.paused ? audio.play().then(loop) : audio.pause(); }
      if (e.code === "ArrowRight" || e.code === "ArrowLeft") { const x = beatAt(audio.currentTime), bi = Math.floor((x.i - G().downbeatIndex) / 4); audio.currentTime = Math.max(0, bar(bi + (e.code === "ArrowRight" ? 1 : -1))); started = true; draw(audio.currentTime); }
    });
  }
  return { W, H, shape, clamp, p, io, out, out5, back, lerp, $, $$, beat, bar, b, barBeat, beatAt, pulse, show, slam, pop, type, count, camera, at, cursor, scene, run, time };
})();
