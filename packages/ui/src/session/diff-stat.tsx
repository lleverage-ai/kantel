import "./diff-stat.css";

const count = new Intl.NumberFormat("en-GB");

/** "12 lines added, 3 removed": what a screen reader hears for a DiffStat. */
export function diffStatLabel(additions: number, deletions: number): string {
	return `${count.format(additions)} ${additions === 1 ? "line" : "lines"} added, ${count.format(deletions)} removed`;
}

/**
 * Lines added and removed, in monospace: "+12" in emerald and "\u221212" (a true minus) in red, as T3 Code's diff
 * stats. Screen readers hear it in words instead.
 */
export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
	return (
		<span className="hb-diff-stat">
			<span className="hb-diff-stat-add" aria-hidden="true">
				+{count.format(additions)}
			</span>
			<span className="hb-diff-stat-del" aria-hidden="true">
				{"\u2212"}
				{count.format(deletions)}
			</span>
			<span className="hb-sr-only">{diffStatLabel(additions, deletions)}</span>
		</span>
	);
}
