// The video's background: the hero's pixel field (pixel-field.js, copied from the site by sync-pixel-field.mjs),
// redrawn on every frame at the video's time, in the console's dark greys instead of midnight on paper.
//
// The field keeps clear of the caption, as it keeps clear of the hero's headline. It is a pure function of time but
// doesn't repeat, so over the last second a second field, running from the start time, fades in over the first: the
// last frame then matches the first and the loop has no seam.
(() => {
	const START = 6; // seconds into the field's own clock at the video's 0 s, so work is already under way
	const LOOP = 1; // seconds of crossfade at the end
	const frame = document.querySelector(".mv-frame");

	// The field's quiet zones, as the site keeps clear of the hero's headline: the caption's line, and the end card's
	// text. Elsewhere the scenes' cards cover the field, so it shows in the margins and the gaps between them.
	const quiet = document.createElement("div");
	quiet.className = "pixels-quiet";
	quiet.innerHTML = '<div class="cap-zone"></div><div class="end-zone"></div>';
	frame.prepend(quiet);

	const options = {
		ink: "#7d8086", // lit pixels: a mid grey, kept low by the field's own opacity steps, so it never competes with the UI
		line: "hsl(220 5% 15.5%)", // unlit pixels: a half step off the canvas
		accent: "#ec7523",
		cell: 20,
		autoplay: false,
		quiet,
	};
	const make = () => {
		const canvas = document.createElement("canvas");
		canvas.className = "pixels";
		frame.prepend(canvas);
		return { canvas, field: window.mountPixelField(canvas, options) };
	};
	const a = make();
	const b = make();

	window.drawField = (t) => {
		const end = window.END;
		const x = Math.min(1, Math.max(0, (t - (end - LOOP)) / LOOP));
		a.field.render(START + t);
		a.canvas.style.opacity = 1 - x;
		b.canvas.style.opacity = x;
		if (x > 0) b.field.render(START + t - end);
	};
})();
