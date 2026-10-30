import { File } from "lucide-react";
import { formatBytes } from "../../workspace/workspace-model.ts";
import { extensionOf } from "../preview-model.ts";
import type { PreviewBodyProps } from "../registry.ts";

// A file the preview can't draw (an archive, a binary, a format with no renderer yet): what it is and how big, said
// plainly, with Download in the header as the way to open it. Never a broken view.

export default function BinaryBody({ file, bytes, contentType }: PreviewBodyProps) {
	const extension = extensionOf(file.name).toUpperCase();
	const what = extension === "" || extension.length > 6 ? contentType || "A file" : `${extension} file`;
	return (
		<div className="grid h-full place-items-center p-gutter">
			<div className="flex max-w-card flex-col items-center gap-3 text-center">
				<span className="grid size-12 place-items-center rounded-panel bg-raised text-muted">
					<File className="hb-icon" size={24} strokeWidth={1.5} aria-hidden="true" />
				</span>
				<p className="m-0 text-md font-medium text-fg">This file can't be previewed</p>
				<p className="m-0 text-sm leading-normal text-muted">
					{`${what}, ${formatBytes(file.size ?? bytes.byteLength)}. Download it to open it on your computer.`}
				</p>
			</div>
		</div>
	);
}
