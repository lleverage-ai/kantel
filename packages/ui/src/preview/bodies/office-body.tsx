import { DocxView, PptxView, SheetView } from "../../presented/office-view.tsx";
import type { PreviewBodyProps } from "../registry.ts";
import { rendererFor } from "../registry.ts";

// Office files, rendered in the browser from the bytes the host read (office-view.tsx): Word with docx-preview, Excel
// with SheetJS a sheet at a time, PowerPoint with pptx-renderer. Each library is its own chunk.

export default function OfficeBody({ file, bytes, contentType }: PreviewBodyProps) {
	switch (rendererFor(file, contentType).kind) {
		case "docx":
			return <DocxView content={bytes} name={file.name} />;
		case "pptx":
			return <PptxView content={bytes} name={file.name} />;
		default:
			return <SheetView content={bytes} name={file.name} />;
	}
}
