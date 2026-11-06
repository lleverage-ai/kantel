// The hero's pixel field: Lleverage's pixel motif as a texture, a field of small upright pixels behind the hero's text
// that never forms a picture.
//
// The motif is the one Lleverage's agent mark is drawn from (LleverageLoader in the Lleverage app, PixelMark in its
// native apps): a grid of 6-unit cells, each holding a 4 by 5 pixel, unlit ones drawn faintly in a line colour and lit
// ones on top. Here the grid fills the whole hero and three things light it:
//
// - Clouds: slow noise drifting at 30°, lit in five steps of midnight, so pixels switch on and off in stages rather
//   than blur.
// - Work: every so often a small checkered patch somewhere in the open field lights up ring by ring from its middle
//   with the loader's "arrive" flash (on, dip, on), holds, and goes out again. Many small jobs in one bigger system.
// - One orange: every seventh patch arrives in the brand's orange instead, a few pixels at most, and never two at once.
//
// The text sits on top, so the field keeps a quiet zone around it (the children of the elements named by the canvas's
// `data-pixel-quiet`, space-separated ids, a heading or paragraph by its lines rather than its whole column): towards the text the pixels
// thin out and dim, behind it only a sparse, faint few stay, and no work patch or orange lands there. That keeps every frame legible. The field also dissolves pixel by pixel under the
// header and into the section below.
//
// Every frame is a pure function of time, so it can be recorded or frozen, and under reduced motion it draws one frame
// and stops. It pauses when it's off screen or the tab is hidden, draws at most 30 frames a second and caps the
// device pixel ratio at 2.

const CELL_W = 4 / 6;
const CELL_H = 5 / 6;

// Drift: at 30°, slowly. Units are noise cells per second.
const ANGLE = (-30 * Math.PI) / 180;
const COS = Math.cos(ANGLE);
const SIN = Math.sin(ANGLE);
const DRIFT = 0.09;

// The clouds' steps of opacity, at noise thresholds (fbm noise centres on 0.5). A backdrop, so lighter than a band.
const STEPS = [
	[0.54, 0.05],
	[0.59, 0.11],
	[0.64, 0.19],
	[0.69, 0.29],
	[0.75, 0.42],
];
const EDGE = 0.008; // how soft a step is, in noise units

// The quiet zone around the text: how far past its box the field starts to come back, and how much stays behind it.
const QUIET_PAD = 16; // px of clear margin around the text's box before the field starts to return
const QUIET_FALLOFF = 200; // px over which it comes back in full (less on a narrow screen)
const QUIET_DENSITY = 0.2; // share of pixels kept behind the text
const QUIET_LIGHT = 0.16; // and how strongly they're lit, against the open field

// Work patches.
const PATCH_EVERY = 0.6; // seconds between patches
const RING_STAGGER = 0.12; // the loader's ARRIVE_RING_STAGGER_MS
const ARRIVE = 0.9; // the loader's ARRIVE_DURATION_MS
const HOLD = 1.6;
const FADE = 0.7;
const PATCH_LIFE = ARRIVE + HOLD + FADE + 3 * RING_STAGGER;
const ORANGE_EVERY = 7; // every seventh patch: 4.2 s apart, longer than a patch lives, so one orange at a time
const PATCH_TRIES = 8; // places tried for a patch before it's skipped

/** A stable hash of integers to [0, 1). */
function hash(a, b, c) {
	let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2246822519);
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	h ^= h >>> 16;
	return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
	const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
	return t * t * (3 - 2 * t);
};

function noise(x, y, seed) {
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	const u = fade(x - xi);
	const v = fade(y - yi);
	const a = hash(xi, yi, seed);
	const b = hash(xi + 1, yi, seed);
	const c = hash(xi, yi + 1, seed);
	const d = hash(xi + 1, yi + 1, seed);
	return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** The loader's arrive keyframes: 0, up to 1 at 35%, down to 0.2 at 60%, back to 1. */
function arrive(p) {
	if (p <= 0) return 0;
	if (p >= 1) return 1;
	if (p < 0.35) return p / 0.35;
	if (p < 0.6) return 1 - ((p - 0.35) / 0.25) * 0.8;
	return 0.2 + ((p - 0.6) / 0.4) * 0.8;
}

/** Any CSS colour (hex, hsl() and so on) as [r, g, b], by letting a 2D context parse it. */
function toRgb(colour, ctx) {
	ctx.fillStyle = "#000";
	ctx.fillStyle = colour;
	const value = String(ctx.fillStyle);
	if (value.startsWith("#")) {
		const n = Number.parseInt(value.slice(1, 7), 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}
	const [r = 0, g = 0, b = 0] = value.match(/[\d.]+/g)?.map(Number) ?? [];
	return [r, g, b];
}

/**
 * Draws the field on `canvas` and keeps it moving. Returns a handle with `render(t)` (draw the frame at `t` seconds)
 * and `stop()`.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ ink?: string, accent?: string, line?: string, cell?: number, seed?: number, autoplay?: boolean, start?: number, quiet?: Element | Element[] | null }} [options]
 */
export function mountPixelField(canvas, options = {}) {
	const ctx = canvas.getContext("2d");
	if (ctx === null) return { render() {}, stop() {} };
	const seed = options.seed ?? 7;
	/** The elements whose children the field keeps clear of. */
	const quietElements = (
		options.quiet !== undefined
			? [options.quiet].flat()
			: (canvas.dataset.pixelQuiet ?? "").split(/\s+/).map((id) => document.getElementById(id))
	).filter((element) => element instanceof Element);
	const quietChildren = () => quietElements.flatMap((element) => [...element.children]);

	// The page's colours (site.css's --site-* values), read again whenever the theme changes: midnight pixels on paper,
	// or the console's text colour on its dark canvas. Dark ones are hsl() references to the console's tokens, so the
	// ink goes through toRgb rather than a hex parse.
	let accent = "";
	let line = "";
	let inkLevels = [];
	function readColours() {
		const styles = getComputedStyle(canvas);
		const colour = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
		const ink = toRgb(options.ink ?? colour("--site-midnight", "#141e28"), ctx);
		accent = options.accent ?? colour("--site-orange", "#ec7523");
		line = options.line ?? colour("--site-line", "#d8d8d3");
		inkLevels = Array.from({ length: 21 }, (_, i) => `rgba(${ink[0]},${ink[1]},${ink[2]},${(i / 20).toFixed(2)})`);
	}
	readColours();

	let width = 0;
	let height = 0;
	let cell = 12;
	let cols = 0;
	let rows = 0;
	let shift = 0;
	/** Per cell: 0 where the field leaves it out, else how strongly it's lit against the open field (0..1]. */
	let presence = new Float32Array(0);
	/** Per cell: whether a work patch may land there (the open field, away from the text and the edges). */
	let open = new Uint8Array(0);

	function layout() {
		const rect = canvas.getBoundingClientRect();
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		width = rect.width;
		height = rect.height;
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		cell = options.cell ?? (width < 640 ? 9 : width > 1800 ? 14 : 12);
		cols = Math.ceil(width / cell) + 1;
		rows = Math.max(1, Math.ceil(height / cell));
		// Centre the grid, so the cut columns at each edge match.
		shift = (width - cols * cell) / 2;

		// The text's boxes, in the canvas's coordinates: a heading or paragraph by its lines, anything else whole.
		const quiet = [];
		for (const child of quietChildren()) {
			let q = child.getBoundingClientRect();
			if (/^(H\d|P)$/.test(child.tagName)) {
				const range = document.createRange();
				range.selectNodeContents(child);
				q = range.getBoundingClientRect();
			}
			if (q.width === 0 || q.height === 0) continue;
			quiet.push({
				left: q.left - rect.left - QUIET_PAD,
				right: q.right - rect.left + QUIET_PAD,
				top: q.top - rect.top - QUIET_PAD,
				bottom: q.bottom - rect.top + QUIET_PAD,
			});
		}
		const falloff = Math.min(QUIET_FALLOFF, Math.max(64, width * 0.14));

		presence = new Float32Array(cols * rows);
		open = new Uint8Array(cols * rows);
		for (let r = 0; r < rows; r++) {
			const yPx = (r + 0.5) * cell;
			const y = yPx / height;
			// In over the top 8% (under the header), out over the bottom 22% (into the next section).
			const envelope = smoothstep(0, 0.08, y) * (1 - smoothstep(0.78, 1, y));
			for (let c = 0; c < cols; c++) {
				const xPx = shift + (c + 0.5) * cell;
				// 0 on and inside the text's boxes, 1 a falloff away from the nearest.
				let distance = Number.POSITIVE_INFINITY;
				for (const box of quiet) {
					const dx = Math.max(box.left - xPx, 0, xPx - box.right);
					const dy = Math.max(box.top - yPx, 0, yPx - box.bottom);
					distance = Math.min(distance, Math.hypot(dx, dy));
				}
				const calm = smoothstep(0, falloff, distance);
				const keep = envelope * lerp(QUIET_DENSITY, 1, calm);
				const k = r * cols + c;
				if (hash(c, r, seed + 101) < keep) presence[k] = envelope * lerp(QUIET_LIGHT, 1, calm);
				open[k] = calm > 0.98 && envelope > 0.9 ? 1 : 0;
			}
		}
	}

	/** The clouds' opacity at a cell. */
	function cloud(c, r, t) {
		// Rotate onto the 30° line and stretch along it, then drift along it.
		const u = (c * COS - r * SIN) / 10 - t * DRIFT;
		const v = (c * SIN + r * COS) / 7;
		const n = 0.6 * noise(u, v, seed) + 0.4 * noise(c / 6 + t * 0.05, r / 5 - t * 0.07, seed + 1);
		let o = 0;
		for (const [threshold, opacity] of STEPS) o += (opacity - o) * smoothstep(threshold - EDGE, threshold + EDGE, n);
		return o;
	}

	/** Where patch `i` lands: a cell in the open field with room around it, or null. */
	function place(i, radius) {
		for (let n = 0; n < PATCH_TRIES; n++) {
			const c0 = Math.floor(hash(i, 2 + n * 16, seed) * cols);
			const r0 = Math.floor(hash(i, 3 + n * 16, seed) * rows);
			// Clear of the edge columns, which the canvas cuts.
			if (c0 - radius < 1 || c0 + radius >= cols - 1 || r0 - radius < 0 || r0 + radius >= rows) continue;
			// All four corners in the open field, so no part of it reaches the text.
			if (
				open[(r0 - radius) * cols + c0 - radius] &&
				open[(r0 - radius) * cols + c0 + radius] &&
				open[(r0 + radius) * cols + c0 - radius] &&
				open[(r0 + radius) * cols + c0 + radius]
			) {
				return [c0, r0];
			}
		}
		return null;
	}

	/** Lights from the work patches alive at `t`: ink opacity per cell, and the orange cells. */
	function patches(t, inkOut, orangeOut) {
		const first = Math.max(0, Math.floor((t - PATCH_LIFE) / PATCH_EVERY));
		const last = Math.floor(t / PATCH_EVERY);
		for (let i = first; i <= last; i++) {
			const start = i * PATCH_EVERY + hash(i, 1, seed) * PATCH_EVERY * 0.6;
			const age = t - start;
			if (age < 0 || age > PATCH_LIFE) continue;
			const radius = 1 + Math.floor(hash(i, 4, seed) * 3);
			const at = place(i, radius);
			if (at === null) continue;
			const [c0, r0] = at;
			const orange = i % ORANGE_EVERY === 3;
			for (let dy = -radius; dy <= radius; dy++) {
				for (let dx = -radius; dx <= radius; dx++) {
					if ((dx + dy) % 2 !== 0) continue;
					const ring = Math.max(Math.abs(dx), Math.abs(dy));
					// Rings arrive from the middle out and leave from the edge in.
					const local = age - ring * RING_STAGGER;
					let o = arrive(local / ARRIVE);
					const leaving = age - (ARRIVE + HOLD + (radius - ring) * RING_STAGGER);
					if (leaving > 0) o *= 1 - smoothstep(0, FADE, leaving);
					if (o <= 0.01) continue;
					const k = (r0 + dy) * cols + c0 + dx;
					if (orange && ring <= 1) orangeOut.set(k, Math.max(orangeOut.get(k) ?? 0, o));
					else inkOut[k] = Math.max(inkOut[k], o * 0.85);
				}
			}
		}
	}

	let inkBuffer = new Float32Array(0);
	const orangeCells = new Map();

	function render(t) {
		if (inkBuffer.length !== cols * rows) inkBuffer = new Float32Array(cols * rows);
		inkBuffer.fill(0);
		orangeCells.clear();
		patches(t, inkBuffer, orangeCells);

		ctx.clearRect(0, 0, width, height);
		const pw = cell * CELL_W;
		const ph = cell * CELL_H;
		const ox = (cell - pw) / 2;
		const oy = (cell - ph) / 2;

		// Unlit pixels, faint.
		ctx.fillStyle = line;
		ctx.globalAlpha = 0.42;
		ctx.beginPath();
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				if (presence[r * cols + c] === 0) continue;
				ctx.rect(shift + c * cell + ox, r * cell + oy, pw, ph);
			}
		}
		ctx.fill();
		ctx.globalAlpha = 1;

		// Lit pixels, batched by opacity step.
		const buckets = Array.from({ length: inkLevels.length }, () => []);
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const k = r * cols + c;
				const p = presence[k];
				if (p === 0) continue;
				const o = Math.max(cloud(c, r, t) * p, inkBuffer[k]);
				const level = Math.round(o * 20);
				if (level > 0) buckets[level].push(k);
			}
		}
		for (let level = 1; level < buckets.length; level++) {
			const cells = buckets[level];
			if (cells.length === 0) continue;
			ctx.fillStyle = inkLevels[level];
			ctx.beginPath();
			for (const k of cells) ctx.rect(shift + (k % cols) * cell + ox, Math.floor(k / cols) * cell + oy, pw, ph);
			ctx.fill();
		}

		// The orange, on top.
		ctx.fillStyle = accent;
		for (const [k, o] of orangeCells) {
			ctx.globalAlpha = o;
			ctx.fillRect(shift + (k % cols) * cell + ox, Math.floor(k / cols) * cell + oy, pw, ph);
		}
		ctx.globalAlpha = 1;
	}

	// Playback: 30 frames a second at most, only while on screen and visible, never under reduced motion.
	const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
	const startAt = options.start ?? 6;
	let visible = true;
	let frame = 0;
	let last = 0;
	let clock = startAt;
	let stopped = false;

	function tick(now) {
		frame = 0;
		if (stopped || !visible || document.hidden || reduce.matches) return;
		const dt = last === 0 ? 0 : Math.min((now - last) / 1000, 0.1);
		if (last === 0 || now - last >= 1000 / 30 - 2) {
			clock += dt;
			last = now;
			render(clock);
		}
		frame = requestAnimationFrame(tick);
	}

	function play() {
		if (frame !== 0 || stopped || options.autoplay === false) return;
		last = 0;
		frame = requestAnimationFrame(tick);
	}

	layout();
	render(clock);

	// Re-lay the grid when the hero or the text changes size (a resize, or the fonts arriving).
	const resize = new ResizeObserver(() => {
		layout();
		render(clock);
	});
	resize.observe(canvas);
	for (const element of quietElements) resize.observe(element);
	for (const child of quietChildren()) resize.observe(child);
	// A line's width can change when the fonts arrive without its box changing size.
	document.fonts?.ready.then(() => {
		if (stopped) return;
		layout();
		render(clock);
	});
	const theme = new MutationObserver(() => {
		readColours();
		render(clock);
	});
	theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	const seen = new IntersectionObserver(([entry]) => {
		visible = entry?.isIntersecting ?? true;
		if (visible) play();
	});
	seen.observe(canvas);
	const onVisibility = () => {
		if (!document.hidden) play();
	};
	document.addEventListener("visibilitychange", onVisibility);
	const onMotion = () => (reduce.matches ? render(clock) : play());
	reduce.addEventListener("change", onMotion);
	play();

	return {
		render(t) {
			clock = t;
			render(t);
		},
		stop() {
			stopped = true;
			if (frame !== 0) cancelAnimationFrame(frame);
			resize.disconnect();
			theme.disconnect();
			seen.disconnect();
			document.removeEventListener("visibilitychange", onVisibility);
			reduce.removeEventListener("change", onMotion);
		},
	};
}
