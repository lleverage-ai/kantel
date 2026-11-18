import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { SideScroll } from "./side-scroll.tsx";

export default { title: "Primitives/Side scroll" } satisfies StoryDefault;

const COLUMNS = ["Name", "Sandbox ID", "State", "Created", "Type", "Stops in", "Snapshot", "Cost", "Region", "Owner"];

const th = "h-control-md border-b border-border px-3 text-left text-sm font-medium whitespace-nowrap text-muted";
const td = "border-b border-border px-3 py-2.5 whitespace-nowrap";

function Rows({ rows, columns = COLUMNS, long = false }: { rows: number; columns?: string[]; long?: boolean }) {
	return (
		<table className="w-full border-collapse text-md">
			<thead>
				<tr>
					{columns.map((column) => (
						<th key={column} className={th} scope="col">
							{column}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{Array.from({ length: rows }, (_, row) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a fixed sample, never reordered.
					<tr key={row}>
						{columns.map((column, at) => (
							<td key={column} className={td}>
								{long && at === 0 ? `a-sandbox-with-a-long-name-${row}.lleverage.kantel.dev` : `${column} ${row + 1}`}
							</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}

const frame = "min-w-0 rounded-panel border border-border bg-raised";

/** Wider than its card: the right edge fades, and its scrollbar is inside its frame. */
export const Overflowing: Story = () => (
	<div className="flex max-w-card flex-col gap-2 p-4">
		<SideScroll className={frame}>
			<Rows rows={4} />
		</SideScroll>
	</div>
);

/** A long list in a page that scrolls: the bar stays at the bottom of the window until the table's end is in view. */
export const LongList: Story = () => (
	<div className="fixed inset-0 overflow-y-auto">
		<div className="flex max-w-card flex-col gap-2 p-4">
			<SideScroll className={frame}>
				<Rows rows={40} />
			</SideScroll>
		</div>
	</div>
);

/**
 * `fill`: a list page in a fixed-height panel. The title and filters stay put; the table takes the rest, scrolls both
 * ways, and its header row sticks.
 */
export const Fill: Story = () => (
	<div className="fixed inset-0 flex flex-col overflow-y-auto">
		<div className="kt-fill flex min-w-0 flex-col gap-4 p-4">
			<h1 className="m-0 text-heading font-strong">Sandboxes</h1>
			<p className="m-0 text-sm text-muted">The title and this line stay in view down the list.</p>
			<div className="kt-fill flex min-w-0 flex-col gap-2">
				<SideScroll className={frame} fill>
					<Rows rows={40} />
				</SideScroll>
			</div>
		</div>
	</div>
);

/** On the page's ground with no card, as the sandboxes table. */
export const OnCanvas: Story = () => (
	<div className="flex max-w-card flex-col gap-2 p-4">
		<SideScroll className="min-w-0" surface="canvas">
			<Rows rows={4} long />
		</SideScroll>
	</div>
);

/** It fits: no bar, no shadow. */
export const Fits: Story = () => (
	<div className="flex flex-col gap-2 p-4">
		<SideScroll className={frame}>
			<Rows rows={3} columns={["Name", "State", "Created"]} />
		</SideScroll>
	</div>
);

/** Nothing in it yet. */
export const Empty: Story = () => (
	<div className="flex max-w-card flex-col gap-2 p-4">
		<SideScroll className={frame}>
			<Rows rows={0} />
		</SideScroll>
	</div>
);
