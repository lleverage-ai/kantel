// Terminal output with ANSI escape codes, as lines of styled runs for the inline terminal. Only what a command's log
// needs: the SGR codes for the 16 colours (and 256-colour codes that name one of them), bold, dim, italic and
// underline, and a carriage return that redraws its line (a progress bar). Cursor movement, screen clearing and OSC
// sequences (titles, hyperlinks) are dropped rather than shown as junk. Colours are palette indexes, never values:
// the view maps each to its --hb-ansi-N token.

/**
 * One of the terminal's 16 colours by its index: 0 to 7 the normal black, red, green, yellow, blue, magenta, cyan and
 * white, 8 to 15 their bright forms.
 */
export type AnsiColour = number;

export type AnsiStyle = {
	readonly fg?: AnsiColour;
	readonly bg?: AnsiColour;
	readonly bold?: true;
	readonly dim?: true;
	readonly italic?: true;
	readonly underline?: true;
};

export type AnsiRun = { readonly text: string; readonly style: AnsiStyle };

/** One line of output: its runs, in order. An empty line has none. */
export type AnsiLine = readonly AnsiRun[];

type MutableStyle = { -readonly [K in keyof AnsiStyle]: AnsiStyle[K] };

// CSI sequences (ESC [ ... final byte), OSC sequences (ESC ] ... BEL or ESC \), and other two-byte escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape codes is the point.
const ESCAPE = /\u001b\[([0-?]*)[ -/]*([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;

/** Whether the text has any escape code at all; plain output skips the parser. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape codes is the point.
export const hasAnsi = (text: string): boolean => /\u001b/.test(text);

function applySgr(style: MutableStyle, params: string): void {
	const codes = params === "" ? [0] : params.split(/[;:]/).map((part) => (part === "" ? 0 : Number(part)));
	for (let index = 0; index < codes.length; index++) {
		const code = codes[index] ?? 0;
		if (code === 0) {
			for (const key of Object.keys(style) as (keyof MutableStyle)[]) delete style[key];
		} else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 3) style.italic = true;
		else if (code === 4) style.underline = true;
		else if (code === 22) {
			delete style.bold;
			delete style.dim;
		} else if (code === 23) delete style.italic;
		else if (code === 24) delete style.underline;
		else if (code >= 30 && code <= 37) style.fg = code - 30;
		else if (code === 39) delete style.fg;
		else if (code >= 40 && code <= 47) style.bg = code - 40;
		else if (code === 49) delete style.bg;
		else if (code >= 90 && code <= 97) style.fg = code - 90 + 8;
		else if (code >= 100 && code <= 107) style.bg = code - 100 + 8;
		else if (code === 38 || code === 48) {
			// 256 colours (5;n) keep the 16 they share with the palette; others, and true colour (2;r;g;b), use the default.
			const mode = codes[index + 1];
			const target = code === 38 ? "fg" : "bg";
			if (mode === 5) {
				const n = codes[index + 2] ?? -1;
				if (n >= 0 && n < 16) style[target] = n;
				else delete style[target];
				index += 2;
			} else if (mode === 2) {
				delete style[target];
				index += 4;
			}
		}
	}
}

const sameStyle = (a: AnsiStyle, b: AnsiStyle): boolean =>
	a.fg === b.fg &&
	a.bg === b.bg &&
	a.bold === b.bold &&
	a.dim === b.dim &&
	a.italic === b.italic &&
	a.underline === b.underline;

/**
 * Parses terminal output into lines of styled runs. Lines split at "\n" ("\r\n" too); a lone "\r" starts its line over,
 * as a terminal draws a progress bar. A final newline ends the last line rather than adding an empty one.
 */
export function parseAnsi(text: string): AnsiLine[] {
	const lines: AnsiRun[][] = [];
	let line: AnsiRun[] = [];
	const style: MutableStyle = {};
	const push = (chunk: string) => {
		if (chunk === "") return;
		const last = line.at(-1);
		const current = { ...style };
		if (last !== undefined && sameStyle(last.style, current))
			line[line.length - 1] = { ...last, text: last.text + chunk };
		else line.push({ text: chunk, style: current });
	};
	// After a lone "\r", the next text starts the line over.
	let redraw = false;
	const plain = (chunk: string) => {
		const parts = chunk.replace(/\r\n/g, "\n").split("\n");
		parts.forEach((part, index) => {
			if (index > 0) {
				lines.push(line);
				line = [];
				redraw = false;
			}
			part.split("\r").forEach((piece, at) => {
				if (at > 0) redraw = true;
				if (piece === "") return;
				if (redraw) {
					line = [];
					redraw = false;
				}
				push(piece);
			});
		});
	};
	let last = 0;
	for (const match of text.matchAll(ESCAPE)) {
		plain(text.slice(last, match.index));
		last = match.index + match[0].length;
		if (match[2] === "m") applySgr(style, match[1] ?? "");
	}
	plain(text.slice(last));
	lines.push(line);
	if (text === "") return [];
	// A final newline ends the last line: drop the empty line after it.
	if (lines.length > 1 && lines.at(-1)?.length === 0 && stripAnsi(text).endsWith("\n")) lines.pop();
	return lines;
}

/** The text with every escape code removed, for copying and for screen readers. */
export function stripAnsi(text: string): string {
	return text.replace(ESCAPE, "");
}
