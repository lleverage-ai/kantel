// The hero's story: what Kantel does, told in six short scenes beside the headline, each under a caption whose words
// rise in. It's the demo video's (apps/site/video) best moments rebuilt as live HTML on the page's own ground, so it
// sits in the hero over the pixel field instead of in a box.
//
// The markup (HeroStory.astro) says what moves and when, in seconds from its scene's start:
//
//   data-in="t"              rises in at t
//   data-pop="t"             pops in at t, with a little overshoot
//   data-out="t"             fades out at t (with data-in, it shows between the two)
//   data-type="t"            types its text from t, over data-dur seconds (default 1)
//   data-on="t" data-off="t" carries the classes in data-on-class from on to off
//   data-draw="t"            an SVG path that draws itself from t
//
// and each scene's own hook moves what doesn't fit that: the forked cards, the CPU meters, the agent's cursor and
// the requests travelling through the proxy. Every frame is a pure function of time, and only opacity and transform
// animate, so it composites without layout. It draws at most 30 frames a second, only while on screen and visible.
// Under reduced motion nothing moves: each scene shows its finished state for a few seconds, then the next.
//
// The stage is laid out at one size (STAGE_W × STAGE_H) and scaled to its column, so a scene's choreography holds at
// every width.

const STAGE_W = 520;
const STAGE_H = 400;
const FADE = 0.45; // seconds a scene takes to come in and to go
const REDUCED_HOLD = 6; // seconds each finished scene shows under reduced motion

const clamp = (x) => Math.max(0, Math.min(1, x));
const span = (t, a, b) => clamp((t - a) / (b - a));
const out = (x) => 1 - (1 - x) ** 3;
const inOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const back = (x) => 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2;
const lerp = (a, b, x) => a + (b - a) * x;
/** Smooth, deterministic wobble for live meters. */
const wave = (x, seed) =>
	0.5 + 0.22 * Math.sin(x * 1.3 + seed) + 0.14 * Math.sin(x * 2.9 + seed * 2.1) + 0.08 * Math.sin(x * 6.1 + seed * 0.7);

/** Where `el` sits inside `root`, in untransformed layout pixels: [x, y, width, height]. */
function offset(el, root) {
	let x = 0;
	let y = 0;
	let node = el;
	while (node && node !== root) {
		x += node.offsetLeft;
		y += node.offsetTop;
		node = node.offsetParent;
	}
	return [x, y, el.offsetWidth, el.offsetHeight];
}

/** A point `e` of the way along an SVG path, in the path's own units (the stage's pixels). */
function along(path, e) {
	const point = path.getPointAtLength(path.getTotalLength() * clamp(e));
	return [point.x, point.y];
}

/** A dot travelling along a path from a to b, visible only on the way. */
function travel(dot, path, l, a, b) {
	const e = inOut(span(l, a, b));
	const [x, y] = along(path, e);
	dot.style.transform = `translate(${x}px, ${y}px)`;
	dot.style.opacity = l < a || l > b + 0.15 ? 0 : 1;
}

/** Interpolates a list of [time, [x, y]] keys. */
function path(keys, l) {
	let [x, y] = keys[0][1];
	for (let i = 0; i < keys.length - 1; i++) {
		const [a, from] = keys[i];
		const [b, to] = keys[i + 1];
		if (l >= a && l <= b) {
			const e = inOut(span(l, a, b));
			x = lerp(from[0], to[0], e);
			y = lerp(from[1], to[1], e);
		} else if (l > b) [x, y] = to;
	}
	return [x, y];
}

// Each scene's own motion, given its element and its local time in seconds.
const HOOKS = {
	agent(scene, l) {
		const caret = scene.querySelector("[data-caret]");
		const typing = l < 2;
		caret.style.opacity = typing || Math.floor(l / 0.45) % 2 === 0 ? 1 : 0;
	},

	fork(scene, l) {
		const cards = [...scene.querySelectorAll("[data-card]")];
		const [first] = cards;
		const fork = inOut(span(l, 0.5, 1.4));
		cards.forEach((card, i) => {
			if (i > 0) {
				// Out from under the first card into the grid.
				const dx = first.offsetLeft - card.offsetLeft;
				const dy = first.offsetTop - card.offsetTop;
				card.style.transform = `translate(${dx * (1 - fork)}px, ${dy * (1 - fork)}px)`;
				card.style.opacity = l < 0.5 ? 0 : 1;
			}
			const meter = card.querySelector("[data-meter]");
			const done = Number(meter.dataset.done);
			const seed = Number(meter.dataset.seed);
			const load =
				l < done
					? (0.5 + 0.42 * wave(l * 1.7, seed)) * out(span(l, 1.2, 1.9))
					: lerp(0.92, 0.04, out(span(l, done, done + 0.6)));
			meter.style.transform = `scaleX(${load})`;
		});
	},

	desktop(scene, l) {
		const screen = scene.querySelector("[data-screen]");
		const at = (selector, fx = 0.2, fy = 0.55) => {
			const [x, y, w, h] = offset(scene.querySelector(selector), screen);
			return [x + w * fx, y + h * fy];
		};
		const [x, y] = path(
			[
				[0.3, [screen.offsetWidth * 0.8, screen.offsetHeight * 0.9]],
				[1.0, at("[data-target='name']")],
				[2.1, at("[data-target='name']")],
				[2.5, at("[data-target='email']")],
				[3.6, at("[data-target='email']")],
				[4.1, at("[data-target='order']", 0.5)],
				[5.4, at("[data-target='order']", 1.3, 1.6)],
			],
			l,
		);
		const cursor = scene.querySelector("[data-cursor]");
		cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
		cursor.style.opacity = out(span(l, 0.2, 0.5));
		// A ring at each click.
		const ring = scene.querySelector("[data-ring]");
		const click = [1.0, 2.5, 4.1].find((c) => l >= c && l < c + 0.4);
		ring.style.transform = `translate(${x - 12}px, ${y - 12}px) scale(${click === undefined ? 0 : 0.4 + span(l, click, click + 0.4)})`;
		ring.style.opacity = click === undefined ? 0 : 1 - span(l, click, click + 0.4);
		const press = clamp(1 - Math.abs(l - 4.15) / 0.12);
		scene.querySelector("[data-target='order']").style.transform = `scale(${1 - 0.05 * press})`;
	},

	secrets(scene, l) {
		const [toProxy, toGithub, toHook] = ["a", "b", "c"].map((id) => scene.querySelector(`[data-path='${id}']`));
		const [first, second] = scene.querySelectorAll("[data-dot]");
		// The first request takes the placeholder to the proxy, which sends the real token on to GitHub.
		if (l < 2.4) travel(first, toProxy, l, 1.3, 1.9);
		else travel(first, toGithub, l, 2.6, 3.3);
		// The second carries the same placeholder towards webhook.site, and the proxy stops it.
		if (l < 4.9) travel(second, toProxy, l, 4.2, 4.8);
		else {
			travel(second, toHook, l, 5.0, 5.9);
			const e = span(l, 5.0, 5.35);
			second.style.opacity = l > 5.35 ? 0 : 1 - e;
		}
	},

	hosts(scene, l) {
		const paths = scene.querySelectorAll("[data-path]");
		scene.querySelectorAll("[data-blip]").forEach((blip, i) => {
			const online = 1.3 + i * 0.5;
			if (l < online) {
				blip.style.opacity = 0;
				return;
			}
			// A pulse leaving each host for the control plane, over and over: the connection is the host's.
			const phase = ((l - online) / 1.2 + i * 0.3) % 1;
			const [x, y] = along(paths[i], phase);
			blip.style.transform = `translate(${x}px, ${y}px)`;
			blip.style.opacity = Math.sin(Math.PI * phase);
		});
	},
};

/** Mounts the story in `root` (HeroStory.astro's element). Returns `render(t)` and `stop()`. */
export function mountHeroStory(root) {
	const stage = root.querySelector("[data-stage]");
	const inner = root.querySelector("[data-stage-inner]");
	const captions = [...root.querySelectorAll("[data-caption]")];
	const bars = [...root.querySelectorAll("[data-bar]")];
	const scenes = [...root.querySelectorAll("[data-scene]")].map((el, i) => {
		for (const typed of el.querySelectorAll("[data-type]")) typed.dataset.text = typed.textContent ?? "";
		return {
			el,
			name: el.dataset.scene ?? "",
			dur: Number(el.dataset.dur),
			caption: captions[i],
			words: [...(captions[i]?.querySelectorAll("[data-word]") ?? [])],
			moving: [...el.querySelectorAll("[data-in], [data-pop], [data-out]")],
			typed: [...el.querySelectorAll("[data-type]")],
			toggled: [...el.querySelectorAll("[data-on]")],
			drawn: [...el.querySelectorAll("[data-draw]")],
		};
	});
	const starts = [];
	let total = 0;
	for (const scene of scenes) {
		starts.push(total);
		total += scene.dur;
	}

	function drawScene(scene, l, shown) {
		const enter = out(span(l, 0, FADE));
		const leave = 1 - span(l, scene.dur - FADE, scene.dur);
		scene.el.style.visibility = shown ? "visible" : "hidden";
		if (scene.caption) scene.caption.style.visibility = shown ? "visible" : "hidden";
		if (!shown) return;
		scene.el.style.opacity = enter * leave;
		scene.el.style.transform = `translateY(${(1 - enter) * 14 - (1 - leave) * 10}px)`;
		// The caption's words rise in one after another, and leave together.
		scene.caption.style.opacity = leave;
		scene.words.forEach((word, i) => {
			const e = out(span(l, 0.05 + i * 0.07, 0.5 + i * 0.07));
			word.style.opacity = e;
			word.style.transform = `translateY(${(1 - e) * 0.4}em)`;
		});
		for (const el of scene.moving) {
			const { in: a, pop, out: z } = el.dataset;
			let opacity = 1;
			let transform = "";
			if (a !== undefined) {
				const e = out(span(l, Number(a), Number(a) + 0.35));
				opacity *= e;
				transform += ` translateY(${(1 - e) * 8}px)`;
			}
			if (pop !== undefined) {
				const e = span(l, Number(pop), Number(pop) + 0.4);
				opacity *= out(e);
				transform += ` scale(${e === 0 ? 0.85 : lerp(0.85, 1, back(e))})`;
			}
			if (z !== undefined) opacity *= 1 - span(l, Number(z), Number(z) + 0.25);
			el.style.opacity = opacity;
			el.style.transform = transform;
		}
		for (const el of scene.typed) {
			const a = Number(el.dataset.type);
			const text = el.dataset.text ?? "";
			const n = Math.round(text.length * span(l, a, a + Number(el.dataset.dur ?? 1)));
			if (el.textContent?.length !== n) el.textContent = text.slice(0, n);
		}
		for (const el of scene.toggled) {
			const on = l >= Number(el.dataset.on) && l < Number(el.dataset.off ?? Number.POSITIVE_INFINITY);
			for (const name of (el.dataset.onClass ?? "").split(/\s+/).filter(Boolean)) el.classList.toggle(name, on);
		}
		for (const el of scene.drawn) {
			// pathLength="1" on the path, so the dash and its offset are fractions of it.
			el.style.strokeDashoffset = String(1 - out(span(l, Number(el.dataset.draw), Number(el.dataset.draw) + 0.5)));
		}
		HOOKS[scene.name]?.(scene.el, l);
	}

	function render(t) {
		const time = ((t % total) + total) % total;
		let current = scenes.length - 1;
		for (let i = 0; i < scenes.length; i++) if (time >= starts[i]) current = i;
		scenes.forEach((scene, i) => {
			drawScene(scene, time - starts[i], i === current);
		});
		bars.forEach((bar, i) => {
			const progress = i < current ? 1 : i > current ? 0 : span(time, starts[i], starts[i] + scenes[i].dur);
			bar.style.transform = `scaleX(${progress})`;
		});
	}

	// Centre each scene's content in the stage: the extent of its frame's laid-out pieces (not the full-stage SVG or
	// the dots that travel over it), shifted to the middle. Layout doesn't change as a scene plays (only opacity and
	// transform do), so this runs once laid out, and again when the fonts arrive.
	const centre = () => {
		for (const frameEl of root.querySelectorAll("[data-frame]")) {
			let top = Number.POSITIVE_INFINITY;
			let bottom = 0;
			for (const child of frameEl.children) {
				if (child instanceof SVGElement || child.matches("[data-dot], [data-blip]")) continue;
				const [, y, , h] = offset(child, frameEl);
				// A wrapper holding only a centred chip (the hosts' note) has no height of its own to count.
				if (h === 0) continue;
				top = Math.min(top, y);
				bottom = Math.max(bottom, y + h);
			}
			if (bottom > top) frameEl.style.transform = `translateY(${(STAGE_H - top - bottom) / 2}px)`;
		}
	};

	// Fit the stage to its column, and centre it there.
	const fit = () => {
		const scale = Math.min(1, stage.clientWidth / STAGE_W);
		const left = (stage.clientWidth - STAGE_W * scale) / 2;
		inner.style.transform = `translateX(${left}px) scale(${scale})`;
		stage.style.height = `${STAGE_H * scale}px`;
	};
	const resize = new ResizeObserver(fit);
	resize.observe(stage);
	fit();
	centre();
	document.fonts?.ready.then(centre);

	// Playback: 30 frames a second at most, only while on screen and the tab is visible.
	const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
	let clock = 0;
	let last = 0;
	let frame = 0;
	let visible = true;
	let stopped = false;
	let held = 0;

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
		if (frame !== 0 || stopped) return;
		if (reduce.matches) {
			still();
			return;
		}
		last = 0;
		frame = requestAnimationFrame(tick);
	}

	// Reduced motion: each scene at rest, its work done, for a while, then the next.
	let timer = 0;
	function still() {
		window.clearTimeout(timer);
		if (stopped || !reduce.matches) return;
		const i = held % scenes.length;
		render(starts[i] + scenes[i].dur - FADE - 0.05);
		timer = window.setTimeout(() => {
			held += 1;
			still();
		}, REDUCED_HOLD * 1000);
	}

	render(0);
	const seen = new IntersectionObserver(([entry]) => {
		visible = entry?.isIntersecting ?? true;
		if (visible) play();
	});
	seen.observe(root);
	const onVisibility = () => {
		if (!document.hidden) play();
	};
	document.addEventListener("visibilitychange", onVisibility);
	reduce.addEventListener("change", play);
	play();

	return {
		render,
		stop() {
			stopped = true;
			if (frame !== 0) cancelAnimationFrame(frame);
			window.clearTimeout(timer);
			resize.disconnect();
			seen.disconnect();
			document.removeEventListener("visibilitychange", onVisibility);
			reduce.removeEventListener("change", play);
		},
	};
}
