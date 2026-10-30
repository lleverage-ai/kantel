import { documentSlug } from "./document-model.ts";
import "./document-print.css";

// Exporting a document: as Markdown (its own text, saved as a .md file) and as PDF (the browser's print dialog, with
// only the document on the page, so "Save as PDF" makes the file). No server renders a PDF.

/** Saves the Markdown as `<title>.md`. */
export function exportMarkdown(title: string, markdown: string): void {
	const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = `${documentSlug(title)}.md`;
	link.rel = "noopener";
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Prints the document as it shows (the page's element, less its toolbar), alone on light paper: the print dialog's
 * "Save as PDF" is the PDF export. The page's title is the document's while the dialog is open, so the file is named
 * after it.
 */
export function printDocument(title: string, page: HTMLElement): void {
	const copy = document.createElement("div");
	copy.className = "hb-doc-print";
	const shown = page.querySelector(".hb-doc-prose, .hb-markdown");
	copy.innerHTML = (shown ?? page).innerHTML;
	for (const node of copy.querySelectorAll(".hb-doc-toolbar, [contenteditable]")) {
		if (node.classList.contains("hb-doc-toolbar")) node.remove();
		else node.removeAttribute("contenteditable");
	}
	const prose = document.createElement("div");
	prose.className = "hb-doc-prose hb-markdown";
	prose.append(...copy.childNodes);
	copy.append(prose);
	document.body.append(copy);
	document.documentElement.classList.add("hb-doc-printing");
	const previous = document.title;
	document.title = title;
	const done = () => {
		window.removeEventListener("afterprint", done);
		document.documentElement.classList.remove("hb-doc-printing");
		document.title = previous;
		copy.remove();
	};
	window.addEventListener("afterprint", done);
	window.print();
}
