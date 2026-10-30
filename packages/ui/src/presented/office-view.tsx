import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Skeleton } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";
// Only what utilities can't say: docx-preview's wrapper and pages, HTML the viewer doesn't write.
import "./office-view.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

// Office files in the presented-file viewer, rendered in the browser from the bytes the host read:
// - Word (.docx) with docx-preview, which lays the document out as HTML pages;
// - Excel (.xlsx) and CSV/TSV with SheetJS, as a table per sheet;
// - PowerPoint (.pptx) with @aiden0z/pptx-renderer, which draws each slide as HTML and SVG.
// Each library is loaded the first time a file of its kind is opened, not with the console. None of them fetches
// anything: external media in a deck is blocked and a document's links are kept to the web and mail.

type Load =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string }
	| { readonly status: "ready" };

const failure = (what: string, error: unknown): Extract<Load, { status: "error" }> => ({
	status: "error",
	message: `This ${what} couldn't be shown: ${error instanceof Error ? error.message : String(error)}`,
});

/** A link a rendered document may keep: to the web or an address. Any other is dropped; every kept one opens a new tab. */
export function safeHref(href: string): boolean {
	return /^(https?:|mailto:)/i.test(href.trim());
}

/** Makes a rendered document's links safe: web and mail links open in a new tab; any other link loses its target. */
function tameLinks(root: HTMLElement): void {
	for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
		const href = link.getAttribute("href") ?? "";
		if (href.startsWith("#")) continue;
		if (!safeHref(href)) {
			link.removeAttribute("href");
			continue;
		}
		link.target = "_blank";
		link.rel = "noreferrer noopener";
	}
}

/**
 * What a document scrolls over: the sunken ground with padding, as PDF pages are, or, for a spreadsheet's grid, the
 * canvas, edge to edge.
 */
const GROUNDS = { sunken: "bg-sunken px-gutter py-6", canvas: "bg-canvas" } as const;

/** A focusable region the document scrolls in, as the other viewers' bodies. */
function Scroll({
	label,
	scrollRef,
	children,
	ground = "sunken",
}: {
	label: string;
	scrollRef?: RefObject<HTMLElement | null>;
	children: ReactNode;
	ground?: keyof typeof GROUNDS;
}) {
	return (
		<section
			ref={scrollRef}
			// The focus ring inset, so the panel's edges don't clip it. `!`: base.css's .hb-focusable offset is unlayered.
			className={`hb-office-scroll hb-focusable min-h-0 flex-auto overflow-auto overscroll-contain focus-visible:-outline-offset-(--hb-ring)! ${GROUNDS[ground]}`}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable to scroll by keyboard.
			tabIndex={0}
			aria-label={label}
		>
			{children}
		</section>
	);
}

function Status({ load, name }: { load: Load; name: string }) {
	if (load.status === "loading") {
		return (
			<div className="flex flex-col gap-2" aria-busy="true">
				<span className="hb-sr-only">Loading {name}</span>
				<Skeleton width="100%" />
				<Skeleton width="85%" />
				<Skeleton width="90%" />
			</div>
		);
	}
	return load.status === "error" ? <Notice level="error">{load.message}</Notice> : null;
}

/** A Word document, page by page, scaled down to the viewer's width when its pages are wider. */
export function DocxView({ content, name }: { content: Uint8Array; name: string }) {
	const hostRef = useRef<HTMLDivElement>(null);
	const [load, setLoad] = useState<Load>({ status: "loading" });
	useEffect(() => {
		const host = hostRef.current;
		if (host === null) return;
		let cancelled = false;
		setLoad({ status: "loading" });
		host.replaceChildren();
		host.style.removeProperty("zoom");
		import("docx-preview")
			.then(async (docx) => {
				if (cancelled) return;
				// docx-preview writes the document's styles beside it; they are scoped to its `hb-docx` class.
				await docx.renderAsync(content.slice(), host, host, {
					className: "hb-docx",
					inWrapper: true,
					breakPages: true,
					ignoreLastRenderedPageBreak: true,
					renderAltChunks: false,
					renderComments: false,
					useBase64URL: true,
					experimental: false,
				});
				if (cancelled) return;
				tameLinks(host);
				// Pages are their real width (an A4 page is about 800px); a narrower viewer shows them smaller.
				const page = host.querySelector<HTMLElement>("section.hb-docx");
				const available = host.parentElement?.clientWidth ?? host.clientWidth;
				if (page !== null && page.offsetWidth > 0 && available > 0) {
					const scale = Math.min(1, (available - 32) / page.offsetWidth);
					if (scale < 1) host.style.setProperty("zoom", String(scale));
				}
				setLoad({ status: "ready" });
			})
			.catch((error: unknown) => {
				if (!cancelled) setLoad(failure("document", error));
			});
		return () => {
			cancelled = true;
		};
	}, [content]);
	return (
		<Scroll label={`Pages of ${name}`}>
			<Status load={load} name={name} />
			<div ref={hostRef} className="hb-office-docx" />
		</Scroll>
	);
}

/** A PowerPoint deck, slide under slide at the viewer's width. */
export function PptxView({ content, name }: { content: Uint8Array; name: string }) {
	const scrollRef = useRef<HTMLElement>(null);
	const hostRef = useRef<HTMLDivElement>(null);
	const [load, setLoad] = useState<Load>({ status: "loading" });
	useEffect(() => {
		const host = hostRef.current;
		const scroll = scrollRef.current;
		if (host === null || scroll === null) return;
		let cancelled = false;
		let destroy: (() => void) | undefined;
		setLoad({ status: "loading" });
		host.replaceChildren();
		import("@aiden0z/pptx-renderer")
			.then(async ({ PptxViewer, RECOMMENDED_ZIP_LIMITS }) => {
				if (cancelled) return;
				const viewer = await PptxViewer.open(content.slice(), host, {
					fitMode: "contain",
					externalMedia: "block",
					zipLimits: RECOMMENDED_ZIP_LIMITS,
					lazyMedia: true,
					lazySlides: true,
					pdfjs: false,
					scrollContainer: scroll,
					renderMode: "list",
					listOptions: { windowed: true, initialSlides: 3, batchSize: 3, showSlideLabels: true },
					onSlideRendered: (_index, element) => tameLinks(element),
				});
				if (cancelled) {
					viewer.destroy();
					return;
				}
				destroy = () => viewer.destroy();
				setLoad({ status: "ready" });
			})
			.catch((error: unknown) => {
				if (!cancelled) setLoad(failure("presentation", error));
			});
		return () => {
			cancelled = true;
			destroy?.();
		};
	}, [content]);
	return (
		<Scroll label={`Slides of ${name}`} scrollRef={scrollRef}>
			<Status load={load} name={name} />
			<div ref={hostRef} className="min-w-0" />
		</Scroll>
	);
}

/** The most rows and columns of a sheet the viewer shows; a bigger sheet says so. */
export const MAX_SHEET_ROWS = 1000;
export const MAX_SHEET_COLUMNS = 60;

type Sheet = {
	readonly name: string;
	readonly rows: readonly (readonly string[])[];
	readonly columns: number;
	/** The sheet's whole size, when it is more than is shown. */
	readonly clipped?: { readonly rows: number; readonly columns: number };
};

type Book = { readonly status: "ready"; readonly sheets: readonly Sheet[] } | Exclude<Load, { status: "ready" }>;

/** A sheet's tab: muted text over an underline, transparent until it is the sheet shown. */
const sheetTab =
	"hb-focusable flex-none cursor-pointer border-0 border-b-(length:--hb-ring) bg-transparent px-2 py-1 text-sm [font-family:inherit] [font-feature-settings:inherit] [line-height:inherit]";

/** Every cell of the grid, headings too: cut short with an ellipsis, ruled right and below. */
const gridCell = "max-w-[calc(var(--hb-card-width)/2)] truncate border-r border-b border-border px-1.5 py-1";

/** A column's letter or a row's number: held in view on the raised ground as the grid scrolls. */
const gridHeading = `${gridCell} sticky bg-raised`;

/** The column letters, along the top; the corner above the row numbers is over both. */
const columnHeading = `${gridHeading} top-0 z-1 text-center font-medium text-muted`;
const cornerHeading = `${gridHeading} top-0 left-0 z-2 text-center font-medium text-muted`;

/** The row numbers, down the left. */
const rowHeading = `${gridHeading} left-0 text-right font-regular text-faint`;

/** A cell's value. */
const dataCell = `${gridCell} text-left text-fg`;

/** Column letters as a spreadsheet heads them: A, B, …, Z, AA. */
export function columnName(index: number): string {
	let name = "";
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
	return name;
}

/** An Excel workbook or a CSV/TSV file, a sheet at a time, with its cells as Excel formats them. */
export function SheetView({ content, name, text }: { content: Uint8Array; name: string; text?: boolean }) {
	const [book, setBook] = useState<Book>({ status: "loading" });
	const [index, setIndex] = useState(0);
	useEffect(() => {
		let cancelled = false;
		setBook({ status: "loading" });
		setIndex(0);
		import("xlsx")
			.then((XLSX) => {
				if (cancelled) return;
				const tsv = /\.tsv$/i.test(name);
				const workbook =
					text === true
						? XLSX.read(new TextDecoder("utf-8").decode(content), {
								type: "string",
								sheetRows: MAX_SHEET_ROWS + 1,
								...(tsv ? { FS: "\t" } : {}),
							})
						: XLSX.read(content, { type: "array", sheetRows: MAX_SHEET_ROWS + 1, cellHTML: false, bookVBA: false });
				const sheets = workbook.SheetNames.map((sheetName): Sheet => {
					const sheet = workbook.Sheets[sheetName];
					if (sheet === undefined) return { name: sheetName, rows: [], columns: 0 };
					const range = XLSX.utils.decode_range(sheet["!fullref"] ?? sheet["!ref"] ?? "A1:A1");
					const fullRows = range.e.r + 1;
					const fullColumns = range.e.c + 1;
					const all = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
						header: 1,
						raw: false,
						defval: "",
						blankrows: true,
					});
					const columns = Math.min(fullColumns, MAX_SHEET_COLUMNS);
					const rows = all.slice(0, MAX_SHEET_ROWS).map((row) =>
						Array.from({ length: columns }, (_, column) => {
							const value = row[column];
							return value === undefined || value === null ? "" : String(value);
						}),
					);
					const clipped = fullRows > MAX_SHEET_ROWS || fullColumns > MAX_SHEET_COLUMNS;
					return {
						name: sheetName,
						rows,
						columns,
						...(clipped ? { clipped: { rows: fullRows, columns: fullColumns } } : {}),
					};
				});
				setBook({ status: "ready", sheets });
			})
			.catch((error: unknown) => {
				if (!cancelled) setBook(failure(text === true ? "file" : "spreadsheet", error));
			});
		return () => {
			cancelled = true;
		};
	}, [content, name, text]);

	const sheet = book.status === "ready" ? book.sheets[index] : undefined;
	const headings = useMemo(
		() => Array.from({ length: sheet?.columns ?? 0 }, (_, column) => columnName(column)),
		[sheet],
	);
	if (book.status !== "ready") {
		return (
			<Scroll label={`Contents of ${name}`}>
				<Status load={book} name={name} />
			</Scroll>
		);
	}
	return (
		<div className="hb-office-book flex min-h-0 min-w-0 flex-auto flex-col">
			{book.sheets.length > 1 ? (
				<div
					className="flex flex-none gap-0.5 overflow-x-auto border-b border-border px-2 pt-1"
					role="tablist"
					aria-label="Sheets"
				>
					{book.sheets.map((each, at) => (
						<button
							key={each.name}
							type="button"
							role="tab"
							aria-selected={at === index}
							className={`${sheetTab} ${at === index ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`}
							onClick={() => setIndex(at)}
						>
							{each.name}
						</button>
					))}
				</div>
			) : null}
			{sheet?.clipped === undefined ? null : (
				<div className="flex-none px-2 pt-1.5">
					<Notice announce={false}>
						{`Showing ${Math.min(sheet.clipped.rows, MAX_SHEET_ROWS).toLocaleString("en-GB")} of ${sheet.clipped.rows.toLocaleString("en-GB")} rows and ${sheet.columns} of ${sheet.clipped.columns} columns. Download it to see the rest.`}
					</Notice>
				</div>
			)}
			<Scroll label={sheet === undefined ? `Contents of ${name}` : `Sheet ${sheet.name}`} ground="canvas">
				{sheet === undefined || sheet.rows.length === 0 ? (
					<p className="m-0 p-3 text-sm text-muted">This sheet is empty.</p>
				) : (
					<table className="hb-selectable border-separate border-spacing-0 font-mono text-xs leading-tight">
						<thead>
							<tr>
								<th className={cornerHeading}>
									<span className="hb-sr-only">Row</span>
								</th>
								{headings.map((heading) => (
									<th key={heading} scope="col" className={columnHeading}>
										{heading}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{sheet.rows.map((row, at) => (
								// Rows have no identity but their place, and they never move.
								// biome-ignore lint/suspicious/noArrayIndexKey: a sheet's rows are fixed in place.
								<tr key={at}>
									<th scope="row" className={rowHeading}>
										{at + 1}
									</th>
									{row.map((cell, column) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: a row's cells are fixed in place.
										<td key={column} className={dataCell}>
											{cell}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				)}
			</Scroll>
		</div>
	);
}
