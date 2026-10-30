import { PdfView } from "../../presented/pdf-view.tsx";
import type { PreviewBodyProps } from "../registry.ts";
import { BodyScroll } from "./scroll.tsx";

// A PDF, page by page on the sunken backdrop, drawn by pdf.js in its own worker (pdf-view.tsx). pdf.js is its own
// chunk, loaded the first time a PDF opens or a PDF's card is hovered.

export default function PdfBody({ file, bytes, label }: PreviewBodyProps) {
	return (
		<BodyScroll label={label} className="bg-sunken px-gutter py-6">
			<PdfView content={bytes} name={file.name} />
		</BodyScroll>
	);
}
