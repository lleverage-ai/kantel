import type { PresentedFile } from "@harbour/protocol";

// Presented files for the workbench: a report, a page, a PDF built here, and the formats the viewer only downloads.

const encoder = new TextEncoder();

export const presentedFile = (path: string, mimeType: string, size: number, preview?: string): PresentedFile => ({
	workspaceId: "ws-demo",
	path,
	name: path.split("/").at(-1) ?? path,
	mimeType,
	size,
	...(preview === undefined ? {} : { preview }),
});

export const reportMarkdown = `# Quarterly churn review

Churn fell to **2.1%** in Q3, from 2.8% in Q2. Most of the drop came from the annual plan.

## By plan

| Plan | Q2 | Q3 |
| --- | ---: | ---: |
| Monthly | 4.6% | 3.9% |
| Annual | 1.2% | 0.6% |

## Next steps

- [x] Ship the cancellation survey
- [ ] Follow up with the 14 accounts that downgraded
`;

export const dashboardHtml = `<!doctype html>
<html><head><style>
body { font: 15px system-ui, sans-serif; margin: 24px; color: #1d1d1f; }
.bar { height: 18px; background: #4b6bfb; border-radius: 4px; margin: 6px 0; color: white; font-size: 12px; padding-left: 6px; }
</style></head>
<body><h1>Signups by week</h1>
<div class="bar" style="width: 40%">W1 · 120</div>
<div class="bar" style="width: 65%">W2 · 195</div>
<div class="bar" style="width: 90%">W3 · 270</div>
<p id="note">This page runs in a sandbox.</p>
<script>document.getElementById("note").textContent += " Its script ran; it can't reach the console.";</script>
</body></html>
`;

/** A small, valid PDF of `pages` pages, each with a heading, built by hand with a correct cross-reference table. */
export function samplePdf(pages = 2): Uint8Array {
	const objects: string[] = [];
	const pageIds = Array.from({ length: pages }, (_, index) => 4 + index * 2);
	objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
	objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
	pageIds.forEach((id, index) => {
		const text = `BT /F1 28 Tf 72 720 Td (Harbour report, page ${index + 1}) Tj ET BT /F1 14 Tf 72 680 Td (Rendered by pdf.js in the presented-file viewer.) Tj ET`;
		objects[id] =
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
		objects[id + 1] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
	});
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let id = 1; id < objects.length; id++) {
		offsets[id] = body.length;
		body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
	}
	const xref = body.length;
	body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return encoder.encode(body);
}

export const presentedReport = presentedFile(
	"out/churn-review.md",
	"text/markdown",
	encoder.encode(reportMarkdown).length,
	reportMarkdown.split("\n").slice(0, 4).join("\n").trimEnd(),
);
export const presentedPage = presentedFile("out/signups.html", "text/html", encoder.encode(dashboardHtml).length);
export const presentedPdf = presentedFile("out/board-pack.pdf", "application/pdf", samplePdf().length);
export const presentedSheet = presentedFile(
	"out/pipeline.xlsx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	48_213,
);
export const presentedDoc = presentedFile(
	"out/contract-redline.docx",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	1_204_877,
);

export const bytesOf = (text: string): Uint8Array => encoder.encode(text);
