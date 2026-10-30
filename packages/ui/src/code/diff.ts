// Line diffs for the edit view: an edit's old text against its new text, as rows a reader scans like a unified diff.

export type DiffRow =
	| { readonly kind: "same"; readonly text: string; readonly oldLine: number; readonly newLine: number }
	| { readonly kind: "del"; readonly text: string; readonly oldLine: number }
	| { readonly kind: "add"; readonly text: string; readonly newLine: number };

/** Past this many cells (old lines times new lines) the diff is every old line removed, then every new line added. */
const MAX_CELLS = 4_000_000;

const splitLines = (text: string): string[] => {
	if (text === "") return [];
	const lines = text.split(/\r\n|\r|\n/);
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	return lines;
};

/**
 * The rows that turn `before` into `after`, line by line: the longest common subsequence of lines is kept, and every
 * other line is removed or added. Where a change replaces lines, the removals come before the additions. Line numbers
 * count from 1 in each text.
 */
export function diffLines(before: string, after: string): DiffRow[] {
	const a = splitLines(before);
	const b = splitLines(after);
	// Common head and tail first: an edit usually changes a few lines in the middle of what it quotes.
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	const rows: DiffRow[] = [];
	for (let index = 0; index < head; index++) {
		rows.push({ kind: "same", text: a[index] ?? "", oldLine: index + 1, newLine: index + 1 });
	}
	const midA = a.slice(head, a.length - tail);
	const midB = b.slice(head, b.length - tail);
	rows.push(...middle(midA, midB, head, head));
	for (let index = tail; index > 0; index--) {
		const oldIndex = a.length - index;
		const newIndex = b.length - index;
		rows.push({ kind: "same", text: a[oldIndex] ?? "", oldLine: oldIndex + 1, newLine: newIndex + 1 });
	}
	return rows;
}

function middle(a: readonly string[], b: readonly string[], oldStart: number, newStart: number): DiffRow[] {
	const rows: DiffRow[] = [];
	if (a.length * b.length > MAX_CELLS || a.length === 0 || b.length === 0) {
		a.forEach((text, index) => {
			rows.push({ kind: "del", text, oldLine: oldStart + index + 1 });
		});
		b.forEach((text, index) => {
			rows.push({ kind: "add", text, newLine: newStart + index + 1 });
		});
		return rows;
	}
	// lengths[i][j]: the longest common subsequence of a[i..] and b[j..], in one flat array.
	const width = b.length + 1;
	const lengths = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lengths[i * width + j] =
				a[i] === b[j]
					? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
					: Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
		}
	}
	let i = 0;
	let j = 0;
	const added: DiffRow[] = [];
	const flush = () => {
		rows.push(...added);
		added.length = 0;
	};
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			flush();
			rows.push({ kind: "same", text: a[i] ?? "", oldLine: oldStart + i + 1, newLine: newStart + j + 1 });
			i++;
			j++;
		} else if (
			j < b.length &&
			(i === a.length || (lengths[i * width + j + 1] ?? 0) >= (lengths[(i + 1) * width + j] ?? 0))
		) {
			added.push({ kind: "add", text: b[j] ?? "", newLine: newStart + j + 1 });
			j++;
		} else {
			rows.push({ kind: "del", text: a[i] ?? "", oldLine: oldStart + i + 1 });
			i++;
		}
	}
	flush();
	return rows;
}

/** How many lines rows add and remove. */
export function diffCounts(rows: readonly DiffRow[]): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const row of rows) {
		if (row.kind === "add") additions++;
		else if (row.kind === "del") deletions++;
	}
	return { additions, deletions };
}
