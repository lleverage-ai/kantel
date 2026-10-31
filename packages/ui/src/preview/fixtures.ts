// Files for the preview's stories and tests: one of every kind the registry draws, made here so the workbench needs no
// binary fixtures. Not exported from the library.

import type { PreviewContent, PreviewFile } from "./preview-model.ts";

const encoder = new TextEncoder();

export const RAINBOW = `# The colours of the rainbow

A rainbow is sunlight split into its colours by raindrops: each drop bends the light as it enters, reflects it off
the back and bends it again as it leaves, and every colour bends by a slightly different amount.

## The seven colours

1. **Red**, on the outside of the arc, bent least.
2. Orange
3. Yellow
4. Green
5. Blue
6. Indigo
7. **Violet**, on the inside, bent most.

| Colour | Wavelength (nm) |
| ------ | --------------- |
| Red    | 620 to 750      |
| Green  | 495 to 570      |
| Violet | 380 to 450      |

> Newton named seven colours to match the seven notes of a musical scale.

## Seeing one

Stand with the sun behind you and rain in front, with the sun low in the sky: morning or late afternoon.
`;

export const PYTHON = `"""Monthly revenue by region, from the orders export."""

import csv
from collections import defaultdict
from pathlib import Path


def revenue_by_region(path: Path) -> dict[str, float]:
    totals: dict[str, float] = defaultdict(float)
    with path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            totals[row["region"]] += float(row["amount"])
    return dict(sorted(totals.items(), key=lambda item: -item[1]))


if __name__ == "__main__":
    for region, total in revenue_by_region(Path("outputs/data.csv")).items():
        print(f"{region:<12} {total:>12,.2f}")
`;

export const JSON_TEXT = JSON.stringify({
	report: "Quarterly revenue",
	generated: "2026-10-30T09:12:00Z",
	regions: [
		{ name: "Europe", revenue: 1284000.5, growth: 0.084 },
		{ name: "North America", revenue: 2210450, growth: 0.112 },
		{ name: "Asia Pacific", revenue: 940210.25, growth: 0.153 },
	],
	notes: null,
});

const REGIONS = ["Europe", "North America", "Asia Pacific", "Latin America", "Middle East"];

/** A CSV export of `rows` orders: enough rows to show the table only renders what's on screen. */
export function ordersCsv(rows: number): string {
	const lines = ["order_id,date,region,customer,amount,status"];
	for (let at = 1; at <= rows; at++) {
		const day = String((at % 28) + 1).padStart(2, "0");
		const amount = ((at * 7919) % 100000) / 100;
		lines.push(
			`${10000 + at},2026-10-${day},${REGIONS[at % REGIONS.length]},"Customer ${at}, Ltd",${amount.toFixed(2)},${at % 9 === 0 ? "refunded" : "paid"}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

export const HTML_PAGE = `<!doctype html>
<html><head><style>
body { font: 15px/1.5 system-ui, sans-serif; margin: 32px; color: #1f2328; background: #fff; }
.bar { height: 22px; border-radius: 4px; margin: 6px 0; background: linear-gradient(90deg, #6e56cf, #3e63dd); color: #fff; padding-left: 8px; font-size: 13px; }
</style></head><body>
<h1>Revenue by region</h1>
<p>Drawn by the page's own script, in a sandboxed frame.</p>
<div id="bars"></div>
<script>
const data = [["North America", 2210], ["Europe", 1284], ["Asia Pacific", 940]];
const max = Math.max(...data.map((d) => d[1]));
document.getElementById("bars").innerHTML = data
  .map(([name, value]) => '<div class="bar" style="width:' + (value / max) * 100 + '%">' + name + "</div>")
  .join("");
</script>
</body></html>`;

/** A one-page PDF with a heading and a line of text, its cross-reference table worked out here. */
export function minimalPdf(title: string, line: string): Uint8Array {
	const stream = `BT /F1 28 Tf 72 720 Td (${title}) Tj ET\nBT /F1 14 Tf 72 680 Td (${line}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((object, index) => {
		offsets.push(body.length);
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return encoder.encode(body);
}

/** A token's colour as the page has it now, so the chart follows the theme. */
const tokenColour = (name: string): string =>
	getComputedStyle(document.documentElement).getPropertyValue(`--kt-${name}`).trim() || "currentColor";

/** A chart as PNG bytes, drawn on a canvas in the theme's colours: the workbench has no image fixtures. */
export async function chartPng(width = 960, height = 600): Promise<Uint8Array> {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (context === null) return new Uint8Array();
	context.fillStyle = tokenColour("sunken");
	context.fillRect(0, 0, width, height);
	const bars = [0.42, 0.66, 0.51, 0.83, 0.74, 0.92];
	const colours = ["accent", "status-working", "status-waiting", "status-done", "status-approval", "status-error"];
	bars.forEach((value, index) => {
		const barWidth = width / (bars.length * 1.6);
		const x = width * 0.1 + index * barWidth * 1.4;
		context.fillStyle = tokenColour(colours[index] ?? "accent");
		context.fillRect(x, height * 0.9 - value * height * 0.7, barWidth, value * height * 0.7);
	});
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
	return blob === null ? new Uint8Array() : new Uint8Array(await blob.arrayBuffer());
}

/** A file and its content, ready for the preview. */
export type Fixture = { readonly file: PreviewFile; readonly content: PreviewContent };

const text = (key: string, path: string, value: string, extra: Partial<PreviewFile> = {}): Fixture => {
	const bytes = encoder.encode(value);
	return {
		file: { key, name: path.slice(path.lastIndexOf("/") + 1), path, size: bytes.byteLength, ...extra },
		content: { status: "ready", bytes },
	};
};

/** One file of each text kind. */
export const TEXT_FIXTURES: readonly Fixture[] = [
	text("report", "outputs/report.md", RAINBOW, { title: "The colours of the rainbow" }),
	text("analysis", "outputs/analysis.py", PYTHON),
	text("summary", "outputs/summary.json", JSON_TEXT),
	text("data", "outputs/data.csv", ordersCsv(2500)),
	text("page", "outputs/page.html", HTML_PAGE),
];

export function pdfFixture(): Fixture {
	const bytes = minimalPdf("The colours of the rainbow", "Red, orange, yellow, green, blue, indigo, violet.");
	return {
		file: { key: "pdf", name: "rainbow.pdf", path: "outputs/rainbow.pdf", size: bytes.byteLength },
		content: { status: "ready", bytes, contentType: "application/pdf" },
	};
}

export function binaryFixture(): Fixture {
	const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0xff, 0xfe]);
	return {
		file: { key: "zip", name: "release.zip", path: "dist/release.zip", size: 48_213_504 },
		content: { status: "ready", bytes, contentType: "application/zip" },
	};
}
