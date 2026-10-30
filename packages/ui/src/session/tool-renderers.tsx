import type { ToolItem } from "@harbour/protocol";
import type { ReactNode } from "react";
import { PresentedFiles } from "../presented/presented-file-card.tsx";
import { GeneratedImages, ImagePlaceholders } from "./generated-image.tsx";
import { ToolCallChip } from "./tool-call.tsx";
import { type ToolInPlaceProps, type ToolRenderer, type ToolRenderers, toolRenderers } from "./tool-renderer-model.ts";
import { codingToolRenderers } from "./tool-views.tsx";

// The library's tool renderers (the registry itself is in tool-renderer-model.ts). To give a tool a rendering of its
// own, add an entry here, or pass a registry to `Transcript` (`toolRenderers`). packages/ui/docs/session-transcript.md
// ("Tool renderers") says when to use which kind.

/** The generic tool-call row for one call, on its own: what a call rendered in place is while it has nothing else. */
export function GenericToolCall({ item, linked = false }: { item: ToolItem; linked?: boolean }) {
	return (
		<div className="hb-tool-group">
			<ToolCallChip item={item} linked={linked} />
		</div>
	);
}

const presented = (item: ToolItem): boolean => item.status === "done" && (item.files?.length ?? 0) > 0;

/**
 * `present_files` and `create_document`: the files the call presented, as cards (an image as its picture, when the host
 * can read it), instead of its "Presenting 4 files" row.
 */
function presentedInPlace({ item, onOpenFile, openFile, previewImage }: ToolInPlaceProps): ReactNode {
	return <PresentedFiles item={item} onOpen={onOpenFile} openKey={openFile} previewImage={previewImage} />;
}

/**
 * `generate_image`: while it runs, its row with a placeholder the shape of each image to come under it; once done, the
 * images as cards with the model that made them, instead of its "Making an image" row.
 */
function generatedInPlace({ item, onOpenFile, openFile, previewImage, linked }: ToolInPlaceProps): ReactNode {
	if (item.status === "running") {
		return (
			<>
				<GenericToolCall item={item} linked={linked} />
				<ImagePlaceholders item={item} />
			</>
		);
	}
	return <GeneratedImages item={item} onOpen={onOpenFile} openKey={openFile} previewImage={previewImage} />;
}

/**
 * The library's own entries: Harbour's tools whose calls show as more than a row, in place, and the file and shell
 * tools, whose rows open to a card (tool-views.tsx).
 */
export const defaultToolRenderers: readonly ToolRenderer[] = [
	{ tools: ["present_files", "create_document"], inPlace: presentedInPlace, shows: presented },
	{
		tools: ["generate_image"],
		inPlace: generatedInPlace,
		shows: (item) => item.status === "running" || presented(item),
	},
	...codingToolRenderers,
];

/** The registry a transcript uses when its host gives none. */
export const DEFAULT_TOOL_RENDERERS: ToolRenderers = toolRenderers(defaultToolRenderers);
