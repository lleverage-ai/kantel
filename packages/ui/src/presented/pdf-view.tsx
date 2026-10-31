import { useEffect, useRef, useState } from "react";
import { Skeleton } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";

// A PDF, rendered page by page with pdf.js onto canvases that fill the viewer's width. pdf.js is loaded the first time
// a PDF is opened, not with the console, and parses in its own worker.

/** The most pages the viewer renders; a longer document says how many more there are. */
export const MAX_PDF_PAGES = 200;

type PdfJs = typeof import("pdfjs-dist");
let loading: Promise<PdfJs> | undefined;

/** pdf.js, with its worker, loaded once. */
function loadPdfJs(): Promise<PdfJs> {
	if (loading === undefined) {
		const started = Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(
			([pdfjs, worker]) => {
				pdfjs.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
				return pdfjs;
			},
		);
		loading = started;
		// A failed load (the network dropped) is tried again next time.
		started.catch(() => {
			if (loading === started) loading = undefined;
		});
	}
	return loading;
}

type PdfState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string }
	| { readonly status: "ready"; readonly pages: number; readonly shown: number };

/** The document's pages, one canvas each, at the viewer's width and the screen's pixel density. */
export function PdfView({ content, name }: { content: Uint8Array; name: string }) {
	const pagesRef = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<PdfState>({ status: "loading" });

	useEffect(() => {
		const container = pagesRef.current;
		if (container === null) return;
		let cancelled = false;
		let destroy: (() => void) | undefined;
		setState({ status: "loading" });
		container.replaceChildren();
		(async () => {
			const pdfjs = await loadPdfJs();
			if (cancelled) return;
			// pdf.js takes the buffer over, so it gets a copy: the host keeps its bytes for Download.
			const task = pdfjs.getDocument({ data: content.slice() });
			destroy = () => void task.destroy();
			const doc = await task.promise;
			if (cancelled) return;
			const shown = Math.min(doc.numPages, MAX_PDF_PAGES);
			setState({ status: "ready", pages: doc.numPages, shown });
			const ratio = window.devicePixelRatio || 1;
			for (let number = 1; number <= shown; number++) {
				const page = await doc.getPage(number);
				if (cancelled) return;
				const width = Math.max(container.clientWidth, 320);
				const natural = page.getViewport({ scale: 1 });
				const viewport = page.getViewport({ scale: (width / natural.width) * ratio });
				const canvas = document.createElement("canvas");
				// A page on the sunken ground: white, a small radius and the float shadow, at the viewer's width.
				canvas.className = "kt-pdf-page block h-auto w-full rounded-xs bg-on-solid shadow-float";
				canvas.width = Math.floor(viewport.width);
				canvas.height = Math.floor(viewport.height);
				canvas.setAttribute("role", "img");
				canvas.setAttribute("aria-label", `Page ${number} of ${doc.numPages}`);
				container.append(canvas);
				await page.render({ canvas, viewport }).promise;
				page.cleanup();
			}
		})().catch((error: unknown) => {
			if (!cancelled) {
				setState({
					status: "error",
					message: `This PDF couldn't be shown: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		});
		return () => {
			cancelled = true;
			destroy?.();
		};
	}, [content]);

	return (
		<div className="kt-pdf-view flex min-w-0 flex-col gap-4">
			{state.status === "loading" ? (
				<div className="kt-pdf-loading flex flex-col gap-2" aria-busy="true">
					<span className="kt-sr-only">Loading {name}</span>
					<Skeleton width="100%" />
					<Skeleton width="80%" />
					<Skeleton width="90%" />
				</div>
			) : null}
			{state.status === "error" ? <Notice level="error">{state.message}</Notice> : null}
			<div ref={pagesRef} className="kt-pdf-pages flex min-w-0 flex-col gap-4" />
			{state.status === "ready" && state.shown < state.pages ? (
				<Notice announce={false}>
					{`Showing the first ${state.shown} of ${state.pages} pages. Download it to read the rest.`}
				</Notice>
			) : null}
		</div>
	);
}
