// Scene kinds: a PLAN of items laid end to end on the bar grid.
//   MV.plan([{ kind: "cover", bars: 2, ... }, { kind: "words", bars: 3, words: [...] }, ...])
// Each item takes `bars` (its length) and optionally `transition` ("wipe" | "flash" | "cut") and `id`.
// The first item starts at 0 s (it is the thumbnail) and runs to the end of its bars counted from bar 0; the
// last item runs to window.END. Beats inside an item count from its first downbeat.
// A brand layer sets MV.brand = { logo(dark) → html } and may add kinds with MV.kind(name, build).
(() => {
  const { $, $$, p, out, out5, lerp, show, slam, pulse } = MV;
  const kinds = {};
  MV.brand = MV.brand || { logo: () => "" };
  MV.kind = (name, build) => (kinds[name] = build);
  const head = (o, dark) => `<div class="k-head"><span class="k-logo">${MV.brand.logo(dark)}</span>${o.tag ? `<span class="k-tag">${o.tag}</span>` : ""}</div>`;
  const section = (o, cls, html) => { const el = document.createElement("section"); el.className = `scene ${cls}`; el.id = o.id; el.innerHTML = html; $(".mv-frame").appendChild(el); return el; };
  MV.section = section; MV.head = head;

  // Cover, also the thumbnail: static from frame 0, the accent bar pulses with the beat.
  MV.kind("cover", (o) => {
    const el = section(o, "dark k-cover", `<div class="k-kicker"><div class="k-bar"></div><span>${o.kicker || ""}</span></div><h1>${o.title}</h1>${o.line ? `<p>${o.line}</p>` : ""}
      <div class="k-mark">${MV.brand.logo(true)}</div>${o.foot ? `<div class="k-foot">${o.foot}</div>` : ""}`);
    return { el, render(t) { $(".k-bar", el).style.transform = `scaleX(${1 + 0.6 * pulse(t, 0.3) * (t > 0.4 ? 1 : 0)})`; } };
  });
  // A total that climbs as one column per beat lands: { label, items: [[label, n], ...] }.
  MV.kind("count", (o) => {
    const max = Math.max(...o.items.map((x) => x[1]));
    const el = section(o, "dark k-count", `${head(o, true)}<div class="k-num">0</div><div class="k-label">${o.label}</div>
      <div class="k-cols">${o.items.map(([l, n]) => `<div class="k-c"><div class="k-v">${n}</div><div class="k-cb"><i style="height:${(n / max) * 100}%"></i></div><div class="k-cl">${l}</div></div>`).join("")}</div>`);
    return { el, render(t, c) {
      let total = 0, shown = 0;
      $$(".k-c", el).forEach((col, i) => { const a = MV.b(c.bar0, i * (o.every || 1)), q = out5(p(t, a, a + 0.22)); $("i", col).style.transform = `scaleY(${q})`; $(".k-v", col).style.opacity = q; const prev = total; total += o.items[i][1]; if (t >= a) shown = Math.round(lerp(prev, total, out(p(t, a, a + 0.25)))); });
      $(".k-num", el).textContent = shown; $(".k-num", el).style.transform = `scale(${1 + 0.05 * pulse(t, 0.25)})`;
    } };
  });
  // Big words, one per bar (or every `every` bars): { words: [html, ...] }.
  MV.kind("words", (o) => {
    const el = section(o, "dark k-words", `<div class="k-big">${o.words.map((w) => `<div>${w}</div>`).join("")}</div>`);
    const ev = o.every || 1;
    return { el, render(t, c) { $$(".k-big > div", el).forEach((d, i) => slam(d, t, MV.bar(c.bar0 + i * ev), i < o.words.length - 1 ? MV.bar(c.bar0 + (i + 1) * ev) : Infinity)); $(".k-big", el).style.transform = `scale(${1 + 0.03 * pulse(t)})`; } };
  });
  // Statements for a quiet section: { items: [[headline html, sub], ...], every: 2, tail?: html } — slow fades.
  MV.kind("statements", (o) => {
    const ev = o.every || 2;
    const el = section(o, "dark k-statements", `${head(o, true)}${o.items.map(([h, s]) => `<div class="k-st"><h3>${h}</h3>${s ? `<p>${s}</p>` : ""}</div>`).join("")}${o.tail ? `<div class="k-st k-tail"><h3>${o.tail}</h3></div>` : ""}`);
    return { el, render(t, c) {
      $$(".k-st", el).forEach((d, i) => {
        const a = MV.bar(c.bar0 + i * ev), z = i < o.items.length - 1 || o.tail ? MV.bar(c.bar0 + (i + 1) * ev) : Infinity;
        if (d.classList.contains("k-tail")) return slam($("h3", d), t, a, Infinity, 1.15);
        show($("h3", d), t, a, z, 40, 0.8); const sp = $("p", d); if (sp) show(sp, t, MV.b(c.bar0 + i * ev, 2), z, 20, 0.8);
      });
    } };
  });
  // A number stepping on each beat: { kicker, steps: [205, 180, ..., 32], unit, was, every: 1 }.
  MV.kind("stat", (o) => {
    const el = section(o, "dark k-stat", `${head(o, true)}<div class="k-k">${o.kicker || ""}</div><div class="k-n"><span>${o.steps[0]}</span><span class="k-u">${o.unit || ""}</span></div>
      ${o.was ? `<div class="k-was">${o.was}</div>` : ""}<div class="k-track"><i></i></div>`);
    return { el, render(t, c) {
      const ev = o.every || 1, s = o.steps, steps = s.map((v, i) => [MV.b(c.bar0, i * ev), v]);
      MV.count($(".k-n span", el), t, steps);
      const v = +$(".k-n span", el).textContent, lo = Math.min(...s), hi = Math.max(...s);
      $(".k-track i", el).style.transform = `scaleX(${hi === lo ? 1 : 0.05 + 0.95 * (v - Math.min(0, lo)) / hi})`;
      $(".k-n", el).style.transform = `scale(${1 + 0.04 * pulse(t)})`;
      show($(".k-k", el), t, c.a - 0.1, Infinity, 20, 0.3);
      if (o.was) show($(".k-was", el), t, MV.bar(c.bar0 + Math.ceil(s.length * ev / 4)), Infinity, 20);
    } };
  });
  // A titled list, one item per bar: { title: html, items: [[head, sub], ...] }.
  MV.kind("list", (o) => {
    const el = section(o, "k-list", `${head(o, false)}<div class="k-lt"><h2>${o.title}</h2></div><div class="k-li">${o.items.map(([h, s]) => `<div class="k-i"><b>${h}</b>${s ? `<span>${s}</span>` : ""}</div>`).join("")}</div>`);
    return { el, render(t, c) { show($("h2", el), t, c.a - 0.1, Infinity, 30, 0.3); $$(".k-i", el).forEach((d, i) => { const a = MV.bar(c.bar0 + i * (o.every || 1)), q = out5(p(t, a, a + 0.3)); d.style.opacity = q; d.style.transform = `translateX(${(1 - q) * 80}px)`; }); } };
  });
  // Rapid fire: an item every `every` beats (default 2), with a progress row: { items: [text, ...] }.
  MV.kind("rapid", (o) => {
    const ev = o.every || 2;
    const el = section(o, "dark k-rapid", `${head(o, true)}<div class="k-rn"></div><div class="k-ri"></div><div class="k-rt">${o.items.map(() => "<i></i>").join("")}</div>`);
    return { el, render(t, c) {
      let cur = 0; o.items.forEach((_, i) => { if (t >= MV.b(c.bar0, ev * i)) cur = i; });
      $$(".k-rt i", el).forEach((d, i) => d.classList.toggle("on", t >= MV.b(c.bar0, ev * i)));
      const ri = $(".k-ri", el); if (ri.dataset.i !== String(cur)) { ri.innerHTML = o.items[cur]; ri.dataset.i = cur; }
      $(".k-rn", el).textContent = String(cur + 1).padStart(2, "0") + " / " + String(o.items.length).padStart(2, "0");
      const q = out5(p(t, MV.b(c.bar0, ev * cur), MV.b(c.bar0, ev * cur) + 0.18)); ri.style.opacity = q; ri.style.transform = `translateY(${(1 - q) * 60}px) scale(${lerp(1.08, 1, q)})`;
    } };
  });
  // Tiles landing every `every` beats (default 2): { items: [[number, line1, line2], ...] }.
  MV.kind("grid", (o) => {
    const el = section(o, "k-grid", `${head(o, false)}<div class="k-g">${o.items.map(([n, a, z]) => `<div class="k-t"><span>${n}</span><b>${a}${z ? `<br><em>${z}</em>` : ""}</b></div>`).join("")}</div>`);
    return { el, render(t, c) { $$(".k-t", el).forEach((d, i) => { const a = MV.b(c.bar0, i * (o.every || 2)), q = out5(p(t, a, a + 0.25)); d.style.opacity = q; d.style.transform = `translateY(${(1 - q) * 40}px) scale(${lerp(0.94, 1, q)})`; }); } };
  });
  // End card: { kicker, title, line?, credit: true (window.CREDIT from music.mjs) }.
  MV.kind("end", (o) => {
    const credit = o.credit !== false && window.CREDIT ? window.CREDIT.join("<br>") : "";
    const el = section(o, "dark k-cover k-end", `<div class="k-kicker"><div class="k-bar"></div><span>${o.kicker || ""}</span></div><h1>${o.title}</h1>${o.line ? `<p>${o.line}</p>` : ""}${credit ? `<p class="k-credit">${credit}</p>` : ""}
      <div class="k-mark">${MV.brand.logo(true)}</div>${o.foot ? `<div class="k-foot">${o.foot}</div>` : ""}`);
    return { el, render(t, c) { $$(".k-kicker, h1, p", el).forEach((d, i) => { const r = out(p(t, c.a + i * 0.12, c.a + i * 0.12 + 0.6)); d.style.opacity = r; d.style.transform = `translateY(${(1 - r) * 24}px)`; }); $(".k-bar", el).style.transform = `scaleX(${out(p(t, c.a, c.a + 0.6))})`; } };
  });
  // Anything else: { kind: "custom", html, cls, init(el, ctx), render(t, el, ctx) }.
  MV.kind("custom", (o) => { const el = section(o, o.cls || "", o.html || ""); return { el, init: o.init && ((c) => o.init(el, c)), render: (t, c) => o.render(t, el, c) }; });

  MV.plan = (items) => {
    let bar0 = 0;
    items.forEach((o, i) => {
      if (!kinds[o.kind]) throw new Error(`unknown scene kind "${o.kind}" (have ${Object.keys(kinds).join(", ")})`);
      o.id = o.id || `s${i + 1}-${o.kind}`;
      const from = i === 0 ? { s: 0 } : bar0, to = i === items.length - 1 ? { s: 1e6 } : bar0 + o.bars;
      const k = kinds[o.kind](o, bar0);
      const start = bar0;
      MV.scene({ el: k.el, from, to, transition: o.transition || (i === 0 ? "cut" : "wipe"), kind: o.kind,
        init: (c) => k.init && k.init({ ...c, bar0: start }),
        render: (t, c) => k.render(t, { ...c, bar0: start }) });
      bar0 += o.bars || 0;
    });
    window.PLAN_BARS = bar0;
  };
})();
