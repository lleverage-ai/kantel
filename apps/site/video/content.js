// Kantel's demo video for kantel.dev's hero: a silent loop, about a minute, that says what Kantel is for in eight
// scenes. Your agent asks for a computer; the heavy work runs in sandboxes, forked to try fixes at once; you watch them
// in the console; a sandbox has a desktop and browser for computer use; secrets reach only where they're bound,
// through the egress proxy; it all runs on machines you own; snapshots and any Linux image make the next sandbox fast.
//
// Every scene is a `custom` item on a silent 100 BPM grid (a bar is 2.4 s, a beat 0.6 s). Scenes have no background:
// the ground is the frame's (theme.css, and the pixel field in field.js), so each one fades its content out at its end and in at its start,
// and the cut between them never shows a seam. Copy and names follow the console (packages/ui/src/compute) and the docs
// (docs/site); the product pieces are drawn here, larger than life, so they read at 600px wide.

const { p, io, out, out5, back, lerp, clamp } = MV;
const BEAT = 0.6;
window.END = 25 * 4 * BEAT; // 60 s: the last scene fades to the bare ground, so the loop restarts cleanly

// ---- helpers

/** Progress 0..1 of an eased entrance starting at `a` (seconds) over `d`. */
const ease = (t, a, d = 0.5, f = out) => f(p(t, a, a + d));
/** Fade and lift `el` in from `a`. */
function rise(el, t, a, dy = 26, d = 0.5) {
	const e = ease(t, a, d);
	el.style.opacity = e;
	el.style.transform = `translateY(${(1 - e) * dy}px)`;
	return e;
}
/** Fade `el` in from `a` and, if given, out at `z`. */
function fade(el, t, a, z = Infinity, d = 0.35) {
	const o = ease(t, a, d) * (z === Infinity ? 1 : 1 - p(t, z, z + d));
	el.style.opacity = o;
	return o;
}
/** A pop: scale up from 0.85 with a little overshoot. */
function popIn(el, t, a, d = 0.45, extra = "") {
	const e = clamp(p(t, a, a + d));
	const s = e === 0 ? 0.85 : lerp(0.85, 1, back(e));
	el.style.opacity = out(e);
	el.style.transform = `${extra} scale(${s})`;
	return e;
}
const $ = (sel, el) => el.querySelector(sel);
const $$ = (sel, el) => [...el.querySelectorAll(sel)];

/** The scene's own entrance and exit: the caption and stage rise in, and everything dips out over the last 0.45 s. */
function frame(t, el, c, end) {
	const z = Math.min(c.z, end ?? c.z);
	const x = 1 - io(p(t, z - 0.45, z));
	el.style.opacity = x;
	const cap = $(".cap", el),
		stage = $(".stage", el);
	if (cap) rise(cap, t, c.a, 22, 0.55);
	if (stage) {
		const e = ease(t, c.a + 0.12, 0.7, out5);
		stage.style.opacity = e;
		stage.style.transform = `translateY(${(1 - e) * 40 + (1 - x) * -16}px) scale(${lerp(0.97, 1, e) + (1 - x) * 0.015})`;
	}
}

/** Deterministic, smooth noise for live meters and sparklines. */
const wave = (x, seed) =>
	0.5 + 0.22 * Math.sin(x * 1.3 + seed) + 0.14 * Math.sin(x * 2.9 + seed * 2.1) + 0.08 * Math.sin(x * 6.1 + seed * 0.7);

/** An SVG sparkline path, 180×56, scrolling with t. */
function spark(t, seed, level = 1) {
	const pts = [];
	for (let i = 0; i <= 24; i++) {
		const v = clamp(wave(i * 0.45 + t * 2.2, seed) * level);
		pts.push(`${((i / 24) * 180).toFixed(1)},${(52 - v * 46).toFixed(1)}`);
	}
	return `M${pts.join(" L")}`;
}

/** Text typed from a to z. */
function typed(el, text, t, a, z) {
	const n = Math.round(text.length * clamp(p(t, a, z)));
	el.textContent = text.slice(0, n);
	return n;
}

/** A point along an SVG path at progress e. */
function along(path, e) {
	const L = path.getTotalLength();
	const pt = path.getPointAtLength(L * clamp(e));
	return [pt.x, pt.y];
}

/** The offset of `el` inside `root`, in untransformed layout pixels. */
function offset(el, root) {
	let x = 0,
		y = 0,
		n = el;
	while (n && n !== root) {
		x += n.offsetLeft;
		y += n.offsetTop;
		n = n.offsetParent;
	}
	return [x, y, el.offsetWidth, el.offsetHeight];
}

const B = (c, n) => c.a + n * BEAT; // beat n of the scene, in seconds

// ---- 1. Your agent asks for a computer

const S1 = {
	kind: "custom",
	bars: 3,
	transition: "cut",
	id: "agent",
	html: `
  <h2 class="cap">Your agent asks for <em>a computer.</em></h2>
  <div class="stage">
    <div class="win" id="s1w" style="left:0;top:40px;width:1248px;height:660px">
      <div class="bar"><span class="dots"><i></i><i></i><i></i></span><b>Your agent</b><span>~/acme/app</span></div>
      <div class="term">
        <div class="ln you"><span id="s1p"></span><span class="caret" id="s1c"></span></div>
        <div class="ln" style="height:22px"></div>
        <div class="ln tool" id="s1l1"><em>●</em> kantel <b>sandbox_create</b>  microvm, 16 vCPU, 32 GB</div>
        <div class="ln ok" id="s1l2">  ✓ sbx_7f3k2m9q running in 1.2 s</div>
        <div class="ln tool" id="s1l3"><em>●</em> kantel <b>sandbox_exec</b>  pnpm test</div>
        <div class="ln" id="s1l4">  1,284 passing, <span class="bad">3 failing</span></div>
        <div class="ln tool" id="s1l5"><em>●</em> kantel <b>sandbox_fork</b>  count 4</div>
        <div class="ln ok" id="s1l6">  ✓ 4 copies running, one fix each</div>
      </div>
    </div>
  </div>`,
	render(t, el, c) {
		frame(t, el, c);
		const prompt = "Run the tests on a clean machine and fix what fails.";
		const n = typed($("#s1p", el), prompt, t, B(c, 0.6), B(c, 3));
		$("#s1c", el).style.opacity = n < prompt.length || Math.floor(t / 0.4) % 2 === 0 ? 1 : 0;
		const at = [3.6, 4.6, 5.8, 7, 8.4, 9.6];
		at.forEach((b, i) => {
			rise($(`#s1l${i + 1}`, el), t, B(c, b), 14, 0.35);
		});
		// A slow push in on the terminal.
		$("#s1w", el).style.transform = `scale(${lerp(1, 1.035, io(p(t, c.a, c.z)))})`;
		$("#s1w", el).style.transformOrigin = "30% 20%";
	},
};

// ---- 2. Fork it and try four fixes at once

const fixes = [
	{ name: "fix-1", res: "2 failing", ok: false, seed: 1.2 },
	{ name: "fix-2", res: "1 failing", ok: false, seed: 2.7 },
	{ name: "fix-3", res: "All 1,287 passing", ok: true, seed: 4.1 },
	{ name: "fix-4", res: "3 failing", ok: false, seed: 5.6 },
];
const S2 = {
	kind: "custom",
	bars: 3,
	transition: "cut",
	id: "fork",
	html: `
  <h2 class="cap">Heavy work runs <em>in sandboxes.</em></h2>
  <div class="stage">
    ${fixes
			.map(
				(f, i) => `
    <div class="win sbx" id="s2c${i}">
      <div class="name">${f.name}</div>
      <div class="meta"><span>MicroVM, 16 vCPU, 32 GB</span><span class="st run"><span class="dot"></span>Running</span></div>
      <div class="meter"><i></i></div>
      <div class="meta"><span>CPU</span><span class="mono cpu">0%</span></div>
      <div class="out"><span class="run-l"><span style="color:var(--k-orange)">$</span> pnpm test</span><span class="res"></span></div>
    </div>`,
			)
			.join("")}
  </div>`,
	render(t, el, c) {
		frame(t, el, c);
		const fork = io(p(t, B(c, 0.8), B(c, 2.6)));
		fixes.forEach((f, i) => {
			const card = $(`#s2c${i}`, el);
			// From one card, centred, out to a 2×2 grid.
			const gx = (i % 2) * 648,
				gy = Math.floor(i / 2) * 414;
			const x = lerp(324, gx, fork),
				y = lerp(207, gy, fork);
			card.style.left = `${x}px`;
			card.style.top = `${y}px`;
			card.style.opacity = i === 0 ? 1 : fork > 0 ? clamp(fork * 3) : 0;
			card.style.zIndex = 4 - i;
			const done = B(c, 7 + i * 0.5);
			const busy = t < done;
			const cpu = busy
				? clamp(0.55 + 0.4 * wave(t * 1.6, f.seed)) * clamp(p(t, B(c, 2), B(c, 3)))
				: lerp(0.9, 0.04, ease(t, done, 0.6));
			$(".meter i", card).style.width = `${cpu * 100}%`;
			$(".cpu", card).textContent = `${Math.round(cpu * 100)}%`;
			$(".run-l", card).style.display = busy ? "" : "none";
			const res = $(".res", card);
			res.innerHTML = busy ? "" : `<span class="badge ${f.ok ? "ok" : "no"}">${f.ok ? "✓ " : ""}${f.res}</span>`;
			if (!busy) popIn(res.firstChild, t, done, 0.4);
			// The one that passes is lit.
			const win = f.ok ? ease(t, B(c, 9.5), 0.5) : 0;
			card.style.borderColor = win > 0 ? `hsl(24 84% 57% / ${win})` : "";
			card.style.boxShadow =
				win > 0 ? `0 0 0 ${4 * win}px hsl(24 84% 57% / ${0.25 * win}), 0 40px 80px -30px rgb(0 0 0 / 0.7)` : "";
			card.style.transform = `scale(${f.ok ? 1 + 0.03 * win : 1 - 0.02 * ease(t, B(c, 9.5), 0.5)})`;
			if (!f.ok) card.style.filter = `brightness(${1 - 0.25 * ease(t, B(c, 9.5), 0.5)})`;
		});
	},
};

// ---- 3. Watch every sandbox, live

const rows = [
	{ name: "fix-3", id: "sbx_7c4x1n8k", type: "MicroVM", seed: 4.1, stays: true },
	{ name: "fix-1", id: "sbx_2m6v9r3k", type: "MicroVM", seed: 1.2 },
	{ name: "fix-2", id: "sbx_9a2b6c4d", type: "MicroVM", seed: 2.7 },
	{ name: "fix-4", id: "sbx_4d8n1x7p", type: "MicroVM", seed: 5.6 },
	{ name: "browser-agent", id: "sbx_6t3y8u2i", type: "MicroVM", seed: 3.3, stays: true },
];
const S3 = {
	kind: "custom",
	bars: 3,
	transition: "cut",
	id: "console",
	html: `
  <h2 class="cap">Watch every sandbox <em>live.</em></h2>
  <div class="stage">
    <div class="win console" id="s3w">
      <div class="side">
        <img src="kantel-lockup-horizontal-on-dark.svg" alt="">
        <div class="nav on">Sandboxes</div><div class="nav">Snapshots</div><div class="nav">Environments</div><div class="nav">Egress</div><div class="nav">Hosts</div>
      </div>
      <div class="main">
        <div class="head"><h3>Sandboxes</h3><span class="btn">+ New</span></div>
        <div class="rows">
          ${rows
						.map(
							(r, i) => `
          <div class="row" id="s3r${i}">
            <div class="n">${r.name}<small>${r.id}</small></div>
            <div class="state"></div>
            <div class="ty">${r.type}</div>
            <svg viewBox="0 0 180 56"><path fill="none" stroke-width="3" stroke-linejoin="round"></path></svg>
          </div>`,
						)
						.join("")}
        </div>
      </div>
    </div>
  </div>`,
	render(t, el, c) {
		frame(t, el, c);
		const stopAt = B(c, 6.5);
		rows.forEach((r, i) => {
			const row = $(`#s3r${i}`, el);
			rise(row, t, B(c, 0.8 + i * 0.35), 18, 0.4);
			const stopping = !r.stays && t >= stopAt + i * 0.3;
			const state = $(".state", row);
			const want = stopping ? "stop" : "run";
			if (state.dataset.s !== want) {
				state.dataset.s = want;
				state.innerHTML = stopping
					? `<span class="st" style="color:var(--k-faint)"><span class="dot"></span>Stopped</span>`
					: `<span class="st run"><span class="dot"></span>Running</span>`;
			}
			const level = stopping ? 1 - ease(t, stopAt + i * 0.3, 0.8) * 0.95 : 1;
			const path = $("path", row);
			path.setAttribute("d", spark(t, r.seed, 0.25 + 0.85 * level));
			path.setAttribute("stroke", stopping ? "hsl(50 8% 45%)" : i === 4 ? "hsl(210 55% 62%)" : "hsl(145 35% 50%)");
			row.style.color = stopping ? "var(--k-muted)" : "";
		});
		// Ease out from close on the table to the whole page.
		const e = io(p(t, B(c, 0.4), B(c, 6)));
		const w = $("#s3w", el);
		w.style.transformOrigin = "60% 30%";
		w.style.transform = `scale(${lerp(1.12, 1, e)})`;
	},
};

// ---- 4. Give it a desktop and a browser

const S4 = {
	kind: "custom",
	bars: 3,
	transition: "cut",
	id: "desktop",
	html: `
  <h2 class="cap">Give it a <em>desktop and browser.</em></h2>
  <div class="stage">
    <div class="win desk" id="s4w">
      <div class="crumbs"><span>Sandboxes  /  browser-agent  /  <b>Desktop</b></span><span class="seg"><span class="on">Control</span><span>Watch</span></span></div>
      <div class="screen">
        <div class="chrome">
          <div class="url"><b style="color:#1d232c">Chromium</b><span>shop.example.com/checkout</span></div>
          <div class="page">
            <h4>Delivery details</h4>
            <div class="field ph" id="s4f1">Full name</div>
            <div class="field ph" id="s4f2">Email</div>
            <div class="field ph" id="s4f3">Delivery date</div>
            <div style="display:flex;align-items:center;margin-top:8px"><span class="go" id="s4go">Place order</span><span class="done" id="s4ok">Order placed ✓</span></div>
          </div>
        </div>
        <div id="s4cur" style="position:absolute;left:0;top:0;width:44px;height:44px;z-index:5">
          <div id="s4ring" style="position:absolute;left:-22px;top:-22px;width:44px;height:44px;border-radius:50%;border:4px solid var(--k-orange)"></div>
          <svg viewBox="0 0 24 24" width="44" height="44"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#ec7523" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
        </div>
      </div>
    </div>
    <div class="chip" id="s4chip" style="right:-20px;bottom:40px"><span class="dot" style="color:var(--k-done)"></span>Playwright connected over CDP</div>
  </div>`,
	render(t, el, c) {
		frame(t, el, c);
		const screen = $(".screen", el);
		const pos = (id, fx = 0.2, fy = 0.5) => {
			const [x, y, w, h] = offset($(id, el), screen);
			return [x + w * fx, y + h * fy];
		};
		// The agent's cursor: into the name field, then email, then the date, then the button.
		const keys = [
			[B(c, 0.5), [900, 640]],
			[B(c, 1.6), pos("#s4f1", 0.15)],
			[B(c, 3.6), pos("#s4f1", 0.15)],
			[B(c, 4.3), pos("#s4f2", 0.15)],
			[B(c, 6.2), pos("#s4f2", 0.15)],
			[B(c, 6.8), pos("#s4f3", 0.15)],
			[B(c, 7.8), pos("#s4f3", 0.15)],
			[B(c, 8.6), pos("#s4go", 0.5)],
			[B(c, 10), pos("#s4go", 1.25, 1.9)],
		];
		const clicks = [B(c, 1.6), B(c, 4.3), B(c, 6.8), B(c, 8.6)];
		let [x, y] = keys[0][1];
		for (let i = 0; i < keys.length - 1; i++) {
			const [a, A] = keys[i],
				[z, Z] = keys[i + 1];
			if (t >= a && t <= z) {
				const e = io(p(t, a, z));
				x = lerp(A[0], Z[0], e);
				y = lerp(A[1], Z[1], e);
			} else if (t > z) [x, y] = Z;
		}
		const cur = $("#s4cur", el);
		cur.style.transform = `translate(${x - 6}px, ${y - 4}px)`;
		cur.style.opacity = ease(t, B(c, 0.4), 0.3);
		const ck = clicks.find((k) => t >= k && t < k + 0.45);
		const ring = $("#s4ring", el);
		if (ck !== undefined) {
			const r = p(t, ck, ck + 0.45);
			ring.style.opacity = 1 - r;
			ring.style.transform = `scale(${0.4 + r})`;
		} else ring.style.opacity = 0;
		// Typing.
		const fill = (id, text, a, z) => {
			const f = $(id, el);
			if (t < a) {
				if (!f.dataset.ph) f.dataset.ph = f.textContent;
				f.textContent = f.dataset.ph;
				f.classList.add("ph");
				return;
			}
			f.dataset.ph = f.dataset.ph || f.textContent;
			f.classList.remove("ph");
			typed(f, text, t, a, z);
			f.style.borderColor = t < z + 0.2 ? "var(--k-orange)" : "";
		};
		fill("#s4f1", "Ada Lovelace", B(c, 1.9), B(c, 3.5));
		fill("#s4f2", "ada@acme.dev", B(c, 4.6), B(c, 6.1));
		fill("#s4f3", "Friday, 14 November", B(c, 7), B(c, 7.7));
		const go = $("#s4go", el);
		const press = clamp(1 - Math.abs(t - B(c, 8.7)) / 0.15);
		go.style.transform = `scale(${1 - 0.05 * press})`;
		popIn($("#s4ok", el), t, B(c, 9), 0.4);
		popIn($("#s4chip", el), t, B(c, 0.9), 0.5);
		// Push in on the form while the agent types, then ease back.
		const w = $("#s4w", el);
		const zin = io(p(t, B(c, 1.2), B(c, 3))) - io(p(t, B(c, 9.3), B(c, 11)));
		w.style.transformOrigin = "30% 55%";
		w.style.transform = `scale(${1 + 0.16 * zin})`;
	},
};

// ---- 5. Secrets your agent never sees

const S5 = {
	kind: "custom",
	bars: 4,
	transition: "cut",
	id: "secrets",
	html: `
  <h2 class="cap">Secrets your agent <em>never sees.</em></h2>
  <div class="stage">
    <svg id="s5svg" width="1248" height="660" style="position:absolute;left:0;top:0;overflow:visible">
      <path id="s5a" d="M330 300 L 600 300" fill="none" />
      <path id="s5b" d="M760 300 C 860 300, 860 105, 980 105" fill="none" />
      <path id="s5c" d="M760 300 C 860 300, 860 495, 980 495" fill="none" />
    </svg>
    <div class="win node" id="s5sbx" style="left:0;top:170px;width:360px;height:260px;z-index:2">
      <h5>Sandbox</h5>
      <div class="mono" style="font-size:27px;line-height:1.6"><span style="color:var(--k-orange)">$</span> <span id="s5cmd"></span><br><span id="s5ph" style="color:var(--k-muted)">kph_7Qx2mR0c…</span></div>
    </div>
    <div class="win node" id="s5px" style="left:540px;top:190px;width:260px;height:220px;text-align:center;z-index:2">
      <svg viewBox="0 0 16 16" width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" style="color:var(--k-orange);margin:6px auto 10px;display:block"><path d="M8 1.75l5 2v4c0 3.2-2.2 5.4-5 6.5-2.8-1.1-5-3.3-5-6.5v-4z"/></svg>
      <div class="big">Egress proxy</div>
      <div style="font-size:24px;color:var(--k-muted);margin-top:6px">on your host</div>
    </div>
    <div class="win node" id="s5gh" style="left:920px;top:40px;width:328px;height:130px;z-index:2">
      <div class="big mono" style="font-size:29px">api.github.com</div>
      <div style="margin-top:14px;height:40px"><span class="badge ok" id="s5ok">✓ 200 OK</span></div>
    </div>
    <div class="win node" id="s5ev" style="left:920px;top:430px;width:328px;height:130px;z-index:2">
      <div class="big mono" style="font-size:29px">webhook.site</div>
      <div style="margin-top:14px;height:40px"><span class="badge no" id="s5no">Denied</span></div>
    </div>
    <div class="pkt" id="s5p1">kph_7Qx2…</div>
    <div class="pkt real" id="s5p1r">ghp_••••••••</div>
    <div class="pkt" id="s5p2">kph_7Qx2…</div>
    <div class="win env" id="s5env">
      <span class="k">GH_TOKEN</span>
      <span><span class="badge acc">Protected</span></span>
      <span style="color:var(--k-muted)">Sent only to <span class="mono" style="color:var(--k-text)">api.github.com</span></span>
    </div>
  </div>`,
	render(t, el, c) {
		frame(t, el, c);
		const svg = $("#s5svg", el);
		for (const path of $$("path", svg)) {
			path.setAttribute("stroke", "hsl(220 4% 34%)");
			path.setAttribute("stroke-width", "4");
			path.setAttribute("stroke-dasharray", "14 12");
			path.setAttribute("stroke-dashoffset", String(-t * 40));
		}
		rise($("#s5env", el), t, B(c, 0.5), 20);
		rise($("#s5sbx", el), t, B(c, 1), 20);
		rise($("#s5px", el), t, B(c, 1.4), 20);
		rise($("#s5gh", el), t, B(c, 1.8), 20);
		rise($("#s5ev", el), t, B(c, 2.1), 20);
		fade(svg, t, B(c, 1.6));
		typed($("#s5cmd", el), "echo $GH_TOKEN", t, B(c, 2.2), B(c, 3.4));
		fade($("#s5ph", el), t, B(c, 3.8));

		// A packet along a path: centred on the point.
		const place = (pk, path, e, o) => {
			const [x, y] = along(path, e);
			pk.style.left = `${x}px`;
			pk.style.top = `${y}px`;
			// Faded near both ends, where it slips behind a node.
			pk.style.opacity = o * clamp(Math.min(e, 1 - e) * 4);
		};
		const A = $("#s5a", el),
			Bp = $("#s5b", el);
		const p1 = $("#s5p1", el),
			p1r = $("#s5p1r", el),
			p2 = $("#s5p2", el);
		// The first request: the placeholder goes to the proxy, which swaps in the real token for api.github.com.
		const a1 = B(c, 4.4),
			s1 = B(c, 6),
			g1 = B(c, 6.6),
			d1 = B(c, 8.2);
		const tr1 = io(p(t, a1, s1));
		place(p1, A, tr1, t < a1 ? 0 : 1);
		p1.style.transform = "translate(-50%, -50%)";
		const tr2 = io(p(t, g1, d1));
		place(p1r, Bp, tr2, t < g1 ? 0 : 1);
		p1r.style.transform = "translate(-50%, -50%)";
		popIn($("#s5ok", el), t, d1 + 0.05, 0.4);
		// The second: the same placeholder, to somewhere it isn't bound. The proxy refuses it.
		const a2 = B(c, 9.4),
			s2 = B(c, 11);
		const tr3 = io(p(t, a2, s2));
		const shake = t > s2 && t < s2 + 0.4 ? Math.sin((t - s2) * 60) * 10 * (1 - p(t, s2, s2 + 0.4)) : 0;
		// It stops short of the proxy, shakes and fades: refused.
		place(p2, A, 0.75 * tr3, t < a2 ? 0 : 1 - p(t, s2 + 0.45, s2 + 0.8));
		p2.style.transform = `translate(-50%, -50%) translateX(${shake}px)`;
		p2.style.borderColor = t > s2 ? "var(--k-error)" : "";
		p2.style.color = t > s2 ? "var(--k-error)" : "";
		popIn($("#s5no", el), t, s2 + 0.1, 0.4);
		// The proxy glows orange for the swap, red for the refusal.
		const gs = clamp(1 - Math.abs(t - s1 - 0.15) / 0.5),
			gr = clamp(1 - Math.abs(t - s2 - 0.15) / 0.5);
		const px = $("#s5px", el);
		px.style.borderColor = gs > 0 ? `hsl(24 84% 57% / ${gs})` : gr > 0 ? `hsl(0 65% 66% / ${gr})` : "";
		px.style.boxShadow = `0 0 ${50 * Math.max(gs, gr)}px ${gs >= gr ? "hsl(24 84% 57% / .45)" : "hsl(0 65% 66% / .45)"}, 0 40px 80px -30px rgb(0 0 0 / 0.7)`;
	},
};

// ---- 6. On machines you own

const hosts = [
	{ name: "home-server", sys: "Debian 13, x86_64", x: 0, at: 3.4 },
	{ name: "build-01", sys: "Ubuntu 24.04, x86_64", x: 432, at: 4.6 },
	{ name: "hetzner-fsn1", sys: "Ubuntu 24.04, 48 vCPU", x: 864, at: 5.4 },
];
const S6 = {
	kind: "custom",
	bars: 3,
	transition: "cut",
	id: "hosts",
	html: `
  <h2 class="cap">On machines <em>you own.</em></h2>
  <div class="stage">
    <div class="win cp" id="s6cp"><img src="kantel-lockup-horizontal-on-dark.svg" alt="Kantel" style="width:190px"><div style="margin-left:auto;text-align:right"><div class="t" style="font-size:28px">Control plane</div><div class="s">app.kantel.dev</div></div></div>
    ${hosts.map((h, i) => `<div class="up" id="s6u${i}" style="left:${h.x + 190}px;top:152px;height:228px"></div><div class="blip" id="s6b${i}" style="left:${h.x + 192}px"></div>`).join("")}
    <div class="chip" id="s6chip" style="left:50%;top:230px">Connects out. No ports to open.</div>
    ${hosts
			.map(
				(h, i) => `
    <div class="win host" id="s6h${i}" style="left:${h.x}px;top:380px">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="t">${h.name}</span><span class="state"></span></div>
      <div class="s">${h.sys}</div>
      <div class="cells">${"<i></i>".repeat(12)}</div>
    </div>`,
			)
			.join("")}
    <div class="win install" id="s6in" style="top:auto;bottom:0"><span style="color:var(--k-orange)">$&nbsp;</span><b id="s6cmd"></b></div>
  </div>`,
	render(t, el, c) {
		frame(t, el, c);
		rise($("#s6cp", el), t, B(c, 0.4), 20);
		rise($("#s6in", el), t, B(c, 0.8), 20);
		typed($("#s6cmd", el), "curl -fsSL …/install.sh | sudo sh -s -- --token kth_8Hq2vX4m", t, B(c, 1.1), B(c, 3));
		hosts.forEach((h, i) => {
			const card = $(`#s6h${i}`, el);
			popIn(card, t, B(c, h.at), 0.5);
			const online = t >= B(c, h.at + 1);
			const st = $(".state", card);
			const want = online ? "on" : "join";
			if (st.dataset.s !== want) {
				st.dataset.s = want;
				st.innerHTML = online
					? `<span class="st run" style="font-size:24px"><span class="dot"></span>Online</span>`
					: `<span class="st start" style="font-size:24px"><span class="dot"></span>Joining</span>`;
			}
			// The connection, drawn up to the control plane, then a pulse travelling out along it every beat.
			const up = $(`#s6u${i}`, el);
			const draw = ease(t, B(c, h.at + 0.3), 0.6);
			up.style.clipPath = `inset(${(1 - draw) * 100}% 0 0 0)`;
			up.style.backgroundPositionY = `${-t * 40}px`;
			const blip = $(`#s6b${i}`, el);
			const ph = ((t - B(c, h.at + 1)) / (BEAT * 2) + i * 0.33) % 1;
			blip.style.top = `${lerp(370, 152, ph)}px`;
			blip.style.opacity = online ? Math.sin(Math.PI * ph) : 0;
			// Sandboxes fill the machine.
			$$(".cells i", card).forEach((cell, k) => {
				const on = t >= B(c, h.at + 1.6 + ((k * 7 + i * 3) % 12) * 0.4) && k < 9 + i;
				cell.className = on ? "on" : "";
			});
		});
		popIn($("#s6chip", el), t, B(c, 6.2), 0.5, "translateX(-50%)");
	},
};

// ---- 7. Snapshots, then any Linux image

const kids = [0, 1, 2, 3, 4, 5].map((i) => ({ x: 560 + (i % 2) * 348, y: 30 + Math.floor(i / 2) * 150 }));
const images = ["debian:trixie", "alpine:3.22", "python:3.13-slim", "ubuntu:24.04", "ghcr.io/acme/ci:latest"];
const S7 = {
	kind: "custom",
	bars: 4,
	transition: "cut",
	id: "snapshots",
	html: `
  <h2 class="cap"><span class="swap" id="s7c1">Set up once. <em>Start in a second.</em></span><span class="swap" id="s7c2">Or boot <em>any Linux image.</em></span>&nbsp;</h2>
  <div class="stage">
    <div id="s7a">
      <svg width="1248" height="620" style="position:absolute;left:0;top:0;overflow:visible" id="s7svg">
        ${kids.map((k, i) => `<path id="s7l${i}" d="M420 360 C 500 360, 480 ${k.y + 48}, ${k.x} ${k.y + 48}" fill="none" stroke="hsl(220 4% 34%)" stroke-width="4" stroke-dasharray="14 12"/>`).join("")}
      </svg>
      <div class="win snap" id="s7src" style="left:0;top:30px;width:420px;height:150px"><div class="t">base-builder</div><div class="s">Node 22, pnpm, deps installed</div></div>
      <div class="win snap" id="s7snap" style="left:0;top:285px;width:420px;height:150px;border-color:var(--k-accent)">
        <div style="display:flex;justify-content:space-between;align-items:center"><span class="t">node22-base</span><span class="badge acc">Saved</span></div>
        <div class="s">Snapshot, 3.4 GB</div>
      </div>
      ${kids.map((k, i) => `<div class="win kid" id="s7k${i}" style="left:${k.x}px;top:${k.y}px"><span class="st run"><span class="dot"></span>Running</span><span class="mono" style="color:var(--k-muted)">0.${8 + (i % 2)} s</span></div>`).join("")}
    </div>
    <div id="s7b">
      ${images.map((im, i) => `<div class="img" id="s7i${i}" style="left:0;top:${i * 112 + 20}px">${im}</div>`).join("")}
      <div class="win snap" id="s7vm" style="left:660px;top:120px;width:588px;height:330px;padding:32px 36px">
        <div class="t" style="font-size:36px">New sandbox</div>
        <div style="display:grid;grid-template-columns:150px 1fr;row-gap:22px;margin-top:30px;font-size:28px">
          <span style="color:var(--k-muted)">Image</span><span class="mono" id="s7img" style="font-size:27px"></span>
          <span style="color:var(--k-muted)">Type</span><span>MicroVM</span>
          <span style="color:var(--k-muted)">State</span><span class="st run"><span class="dot"></span>Running</span>
        </div>
      </div>
      <svg width="1248" height="620" style="position:absolute;left:0;top:0;overflow:visible" id="s7svg2">
        <path id="s7arrow" d="M520 285 L 640 285" fill="none" stroke="hsl(24 84% 57%)" stroke-width="5" stroke-linecap="round"/>
        <path id="s7head" d="M624 271 L 642 285 L 624 299" fill="none" stroke="hsl(24 84% 57%)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
  </div>`,
	render(t, el, c) {
		frame(t, el, c);
		const half = B(c, 8);
		// Captions swap at the half.
		const c1 = $("#s7c1", el),
			c2 = $("#s7c2", el);
		c1.style.opacity = 1 - p(t, half - 0.3, half);
		c1.style.transform = `translateY(${-20 * p(t, half - 0.3, half)}px)`;
		const e2 = ease(t, half, 0.5);
		c2.style.opacity = e2;
		c2.style.transform = `translateY(${(1 - e2) * 22}px)`;
		// Part A: save a snapshot, start six sandboxes from it.
		const A = $("#s7a", el);
		A.style.opacity = 1 - p(t, half - 0.4, half);
		A.style.transform = `translateY(${-30 * io(p(t, half - 0.4, half))}px)`;
		rise($("#s7src", el), t, B(c, 0.6), 20);
		const snap = popIn($("#s7snap", el), t, B(c, 2), 0.5);
		$("#s7src", el).style.boxShadow = `0 0 ${60 * clamp(1 - Math.abs(t - B(c, 1.9)) / 0.4)}px hsl(24 84% 57% / .5)`;
		kids.forEach((_kid, i) => {
			const at = B(c, 3.4 + i * 0.4);
			const line = $(`#s7l${i}`, el);
			const L = 600;
			line.style.strokeDasharray = `${L * ease(t, at - 0.3, 0.4)} ${L}`;
			line.style.opacity = snap > 0 ? 1 : 0;
			popIn($(`#s7k${i}`, el), t, at, 0.45);
		});
		// Part B: any Linux image boots as a microVM.
		const Bp = $("#s7b", el);
		Bp.style.opacity = t < half ? 0 : 1;
		images.forEach((_image, i) => {
			rise($(`#s7i${i}`, el), t, half + 0.2 + i * 0.25, 20, 0.45);
		});
		rise($("#s7vm", el), t, half + 0.6, 20);
		fade($("#s7svg2", el), t, half + 0.9);
		const step = Math.min(images.length - 1, Math.max(0, Math.floor((t - half - 1.2) / (BEAT * 1.25))));
		const label = $("#s7img", el);
		if (label.textContent !== images[step]) label.textContent = images[step];
		images.forEach((_image, i) => {
			const chip = $(`#s7i${i}`, el);
			const on = i === step && t > half + 1.2;
			chip.style.borderColor = on ? "var(--k-accent)" : "";
			chip.style.color = on ? "var(--k-accent-text)" : "";
		});
		const y = 20 + step * 112 + 38;
		$("#s7arrow", el).setAttribute("d", `M520 ${y} C 580 ${y}, 590 285, 640 285`);
	},
};

// ---- 8. The end card

const S8 = {
	kind: "custom",
	bars: 2,
	transition: "cut",
	id: "end",
	html: `
  <div class="endc">
    <img id="s8l" src="kantel-lockup-horizontal-on-dark.svg" alt="Kantel">
    <p id="s8t">Sandboxes for your agents,<br>on <em>your own machines.</em></p>
    <div class="url" id="s8u">kantel.dev</div>
  </div>`,
	render(t, el, c) {
		frame(t, el, c, window.END);
		popIn($("#s8l", el), t, c.a + 0.1, 0.6);
		rise($("#s8t", el), t, B(c, 1), 24, 0.6);
		rise($("#s8u", el), t, B(c, 2.2), 16, 0.5);
	},
};

// index.html reads it as a global.
window.PLAN = [S1, S2, S3, S4, S5, S6, S7, S8];
