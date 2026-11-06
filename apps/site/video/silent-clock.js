// The browser preview's clock. beat-video's engine (mv.js) plays a preview by following an <audio> element's
// currentTime, but this video is silent and has no music.mp3, so the element would never play. This stands in for
// Audio on this page with the same surface the engine uses (currentTime, paused, play() and pause()), timed by
// performance.now() and looping at window.END as the site's copy does. It draws the pixel field (field.js) on every
// frame and seek, as window.seek does for the renderer, so the preview and the recorded frames share one timeline.
// The renderer's ?record mode never creates it.
(() => {
	class SilentClock {
		constructor() {
			this.at = 0; // seconds, when paused or when last started
			this.since = 0; // performance.now() when last started or seeked
			this.playing = false;
			this.frame = 0;
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
			this.at = t;
			this.since = performance.now();
			window.drawField?.(t);
		}

		play() {
			if (!this.playing) {
				this.since = performance.now();
				this.playing = true;
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
