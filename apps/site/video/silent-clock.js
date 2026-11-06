// The browser preview's clock. beat-video's engine (mv.js) plays a preview by following an <audio> element's
// currentTime, but this video is silent and has no music.mp3, so the element would never play. This stands in for
// Audio on this page with the same surface the engine uses (currentTime, paused, play() and pause()), timed by
// performance.now() and looping at window.END as the site's copy does. It draws the pixel field (field.js) on every
// frame and seek, as window.seek does for the renderer, so the preview and the recorded frames share one timeline.
// The renderer's ?record mode never creates it.
//
// It starts at the preview's ?t= position, so Space and the arrow keys work from the frame on screen before any click.
// The engine's first click sets currentTime to that position once. After playback started from the keyboard, the clock
// ignores that reset, so the click only pauses: the engine sets the time inside a click only for that reset, and seeks
// come from keys, so a set made while a click is being handled, once playback has started, is the reset. A capturing
// listener marks the click before the engine's own handler runs.
(() => {
	const start = Number(new URLSearchParams(location.search).get("t")) || 0;
	let inClick = false;
	document.addEventListener(
		"click",
		() => {
			inClick = true;
			setTimeout(() => {
				inClick = false;
			});
		},
		true,
	);

	class SilentClock {
		constructor() {
			this.at = start; // seconds, when paused or when last started
			this.since = 0; // performance.now() when last started or seeked
			this.playing = false;
			this.frame = 0;
			this.played = false; // started at least once
		}

		get paused() {
			return !this.playing;
		}

		get currentTime() {
			if (!this.playing) return this.at;
			const t = this.at + (performance.now() - this.since) / 1000;
			const end = window.END;
			return end ? t % end : t;
		}

		set currentTime(t) {
			// The engine's first-click reset, after the keyboard already started playback: keep the time.
			if (inClick && this.played) return;
			this.at = t;
			this.since = performance.now();
			window.drawField?.(t);
		}

		play() {
			if (!this.playing) {
				this.since = performance.now();
				this.playing = true;
				this.played = true;
				const step = () => {
					if (!this.playing) return;
					window.drawField?.(this.currentTime);
					this.frame = requestAnimationFrame(step);
				};
				this.frame = requestAnimationFrame(step);
			}
			return Promise.resolve();
		}

		pause() {
			this.at = this.currentTime;
			this.playing = false;
			cancelAnimationFrame(this.frame);
		}
	}

	window.Audio = SilentClock;
})();
