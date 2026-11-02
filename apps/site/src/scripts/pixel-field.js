// The hero's pixel field: Lleverage's pixel motif as a texture, a band of small upright pixels that never forms a picture.
//
// The motif is the one Lleverage's agent mark is drawn from (LleverageLoader in the Lleverage app, PixelMark in its
// native apps): a grid of 6-unit cells, each holding a 4 by 5 pixel, unlit ones drawn faintly in a line colour and lit
// ones on top. Here the grid is the width of the page and three things light it:
//
// - Clouds: slow noise drifting along the Kantel beam's 30°, lit in four steps of midnight, so pixels switch on and off
//   in stages rather than blur.
// - Work: every second or so a small checkered patch somewhere in the band lights up ring by ring from its middle with
//   the loader's "arrive" flash (on, dip, on), holds, and goes out again. Many small jobs in one bigger system.
// - One orange: now and then a patch arrives in the brand's orange instead, a few pixels at most.
//
// The band dissolves pixel by pixel at its top and bottom edges. Every frame is a pure function of time, so it can be
// recorded or frozen (`?t=12.5` in the preview), and under reduced motion it draws one frame and stops. It pauses when
// it's off screen or the tab is hidden, and draws at most 30 frames a second.

const CELL_W = 4 / 6;
const CELL_H = 5 / 6;

// Drift: along the beam's angle, slowly. Units are noise cells per second.
const ANGLE = (-30 * Math.PI) / 180;
const COS = Math.cos(ANGLE);
const SIN = Math.sin(ANGLE);
const DRIFT = 0.09;

// The clouds' steps of opacity, at noise thresholds (fbm noise centres on 0.5).
const STEPS = [
	[0.53, 0.06],
	[0.58, 0.13],
	[0.63, 0.22],
	[0.68, 0.34],
	[0.74, 0.5],
];
const EDGE = 0.008; // how soft a step is, in noise units

// Work patches.
const PATCH_EVERY = 0.85; // seconds between patches
const RING_STAGGER = 0.12; // the loader's ARRIVE_RING_STAGGER_MS
const ARRIVE = 0.9; // the loader's ARRIVE_DURATION_MS
const HOLD = 1.6;
const FADE = 0.7;
const PATCH_LIFE = ARRIVE + HOLD + FADE + 3 * RING_STAGGER;
const ORANGE_ONE_IN = 5;

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

function hexToRgb(hex) {
	const value = hex.trim().replace("#", "");
	const full = value.length === 3 ? [...value].map((ch) => ch + ch).join("") : value;
	const n = Number.parseInt(full, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Draws the field on `canvas` and keeps it moving. Returns a handle with `render(t)` (draw the frame at `t` seconds)
 * and `stop()`.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ ink?: string, accent?: string, line?: string, cell?: number, seed?: number, autoplay?: boolean, start?: number }} [options]
 */
export function mountPixelField(canvas, options = {}) {
	const ctx = canvas.getContext("2d");
	if (ctx === null) return { render() {}, stop() {} };
	const styles = getComputedStyle(canvas);
	const colour = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
	const ink = hexToRgb(options.ink ?? colour("--color-midnight", "#141e28"));
	const accent = options.accent ?? colour("--color-orange", "#ec7523");
	const line = options.line ?? colour("--color-line", "#d8d8d3");
	const seed = options.seed ?? 7;
	const inkLevels = Array.from({ length: 21 }, (_, i) => `rgba(${ink[0]},${ink[1]},${ink[2]},${(i / 20).toFixed(2)})`);

	let width = 0;
	let height = 0;
	let cell = 12;
	let cols = 0;
	let rows = 0;
	/** Per cell: whether the band's dissolving edge keeps it, and how strongly (0..1). */
	let presence = new Float32Array(0);

	function layout() {
		const rect = canvas.getBoundingClientRect();
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		width = rect.width;
		height = rect.height;
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		cell = options.cell ?? (width < 640 ? 9 : 12);
		cols = Math.ceil(width / cell) + 1;
		rows = Math.max(1, Math.floor(height / cell));
		presence = new Float32Array(cols * rows);
		for (let r = 0; r < rows; r++) {
			const y = (r + 0.5) / rows;
			// In over the top 30%, out over the bottom 35%: a band that dissolves into the paper at both edges.
			const envelope = smoothstep(0, 0.3, y) * (1 - smoothstep(0.65, 1, y));
			for (let c = 0; c < cols; c++) {
				presence[r * cols + c] = hash(c, r, seed + 101) < envelope ? envelope : 0;
			}
		}
	}

	/** The clouds' opacity at a cell. */
	function cloud(c, r, t) {
		// Rotate onto the beam's angle and stretch along it, then drift along it.
		const u = (c * COS - r * SIN) / 10 - t * DRIFT;
		const v = (c * SIN + r * COS) / 7;
		const n = 0.6 * noise(u, v, seed) + 0.4 * noise(c / 6 + t * 0.05, r / 5 - t * 0.07, seed + 1);
		let o = 0;
		for (const [threshold, opacity] of STEPS) o += (opacity - o) * smoothstep(threshold - EDGE, threshold + EDGE, n);
		return o;
	}

	/** Lights from the work patches alive at `t`: ink opacity per cell, and the orange cells. */
	function patches(t, inkOut, orangeOut) {
		const first = Math.max(0, Math.floor((t - PATCH_LIFE) / PATCH_EVERY));
		const last = Math.floor(t / PATCH_EVERY);
		for (let i = first; i <= last; i++) {
			const start = i * PATCH_EVERY + hash(i, 1, seed) * PATCH_EVERY * 0.6;
			const age = t - start;
			if (age < 0 || age > PATCH_LIFE) continue;
			const c0 = Math.floor(hash(i, 2, seed) * cols);
			// Keep patches in the band's solid middle.
			const r0 = Math.floor(lerp(0.32, 0.62, hash(i, 3, seed)) * rows);
			const radius = 1 + Math.floor(hash(i, 4, seed) * 3);
			const orange = Math.floor(hash(i, 5, seed) * ORANGE_ONE_IN) === 0;
			for (let dy = -radius; dy <= radius; dy++) {
				for (let dx = -radius; dx <= radius; dx++) {
					if ((dx + dy) % 2 !== 0) continue;
					const c = c0 + dx;
					const r = r0 + dy;
					if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
					const ring = Math.max(Math.abs(dx), Math.abs(dy));
					// Rings arrive from the middle out and leave from the edge in.
					const local = age - ring * RING_STAGGER;
					let o = arrive(local / ARRIVE);
					const leaving = age - (ARRIVE + HOLD + (radius - ring) * RING_STAGGER);
					if (leaving > 0) o *= 1 - smoothstep(0, FADE, leaving);
					if (o <= 0.01) continue;
					const k = r * cols + c;
					if (orange && ring <= 1) orangeOut.set(k, Math.max(orangeOut.get(k) ?? 0, o));
					else inkOut[k] = Math.max(inkOut[k], o * 0.9);
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
		// Centre the grid, so the cut columns at each edge match.
		const shift = (width - cols * cell) / 2;

		// Unlit pixels, faint.
		ctx.fillStyle = line;
		ctx.globalAlpha = 0.55;
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
				if (presence[k] === 0) continue;
				const o = Math.max(cloud(c, r, t) * presence[k], inkBuffer[k]);
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
			if (presence[k] === 0) continue;
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

	const resize = new ResizeObserver(() => {
		layout();
		render(clock);
	});
	resize.observe(canvas);
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
			seen.disconnect();
			document.removeEventListener("visibilitychange", onVisibility);
			reduce.removeEventListener("change", onMotion);
		},
	};
}
