// The files sent with the recorded sessions' messages, and what reading one back answers: stand-ins drawn here (the
// photos are small SVG scenes, drawn to a JPEG in the page when first read) so the cards above a bubble have
// thumbnails and open in the panel without a host. Nothing here is real work.

import type { UserAttachment } from "@kantel/protocol";
import { retriesChartBytes } from "@kantel/ui/workspace/image-fixture";
import type { AttachmentContent } from "../api/client.ts";
import { ApiError } from "../api/http.ts";

const encoder = new TextEncoder();

/** A night-time office scene in two colours, for a stand-in photo. */
function scene(sky: string, glow: string, windows: number): string {
	const lit = Array.from({ length: windows }, (_, index) => {
		const x = 30 + (index % 6) * 42;
		const y = 120 + Math.floor(index / 6) * 34;
		return `<rect x="${x}" y="${y}" width="24" height="18" rx="2" fill="${glow}" opacity="${0.45 + (index % 3) * 0.2}"/>`;
	}).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="#05060a"/></linearGradient></defs><rect width="320" height="240" fill="url(#s)"/><circle cx="262" cy="46" r="18" fill="${glow}" opacity="0.8"/><rect x="18" y="104" width="270" height="136" fill="#0d1018"/>${lit}</svg>`;
}

/** The scene as a JPEG, as a photo would be uploaded; the SVG itself where the page can't draw (a test). */
async function photo(markup: string): Promise<AttachmentContent> {
	const svg = { content: encoder.encode(markup), contentType: "image/svg+xml" };
	if (typeof document === "undefined") return svg;
	const image = new Image();
	image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
	await image.decode();
	const canvas = document.createElement("canvas");
	canvas.width = image.naturalWidth;
	canvas.height = image.naturalHeight;
	canvas.getContext("2d")?.drawImage(image, 0, 0);
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
	if (blob === null) return svg;
	return { content: new Uint8Array(await blob.arrayBuffer()), contentType: "image/jpeg" };
}

const text = (body: string, contentType = "text/plain; charset=utf-8"): AttachmentContent => ({
	content: encoder.encode(body),
	contentType,
});

type Read = () => AttachmentContent | Promise<AttachmentContent>;

const FILES: Record<string, { readonly attachment: UserAttachment; readonly read: Read }> = {};

function file(attachment: UserAttachment, read: Read): UserAttachment {
	FILES[attachment.id] = { attachment, read };
	return attachment;
}

const jpeg = (id: string, name: string, size: number, read: Read) =>
	file({ id, name, type: "image/jpeg", size, kind: "image" }, read);

/** One photo on its own. */
export const ONE_IMAGE: readonly UserAttachment[] = [
	jpeg("att-office-dark", "autonomous-back-office-dark.jpg", 221_000, () => photo(scene("#1b2a52", "#f2b84b", 12))),
];

/** Three photos, as Tom sent them. */
export const THREE_IMAGES: readonly UserAttachment[] = [
	ONE_IMAGE[0] as UserAttachment,
	jpeg("att-nacht-in", "Autonome operaties in de nacht.jpg", 269_000, () => photo(scene("#2a1b52", "#7fd1ff", 18))),
	jpeg("att-nacht-bij", "Autonome operaties bij nacht.jpg", 191_000, () => photo(scene("#0f3a3a", "#ffd27f", 9))),
];

/** Six of all kinds, with names too long for a card. */
export const SIX_FILES: readonly UserAttachment[] = [
	jpeg(
		"att-long-photo",
		"autonomous-back-office-dark-final-final-v7-approved-by-marketing-2026-10-30.jpg",
		318_000,
		() => photo(scene("#3a1b2a", "#ff9f7f", 15)),
	),
	file({ id: "att-chart", name: "charges-per-hour.png", type: "image/png", size: 12_800, kind: "image" }, () => ({
		content: retriesChartBytes(),
		contentType: "image/png",
	})),
	file(
		{
			id: "att-brief",
			name: "Brand guidelines for the autonomous operations campaign (Q4 2026).pdf",
			type: "application/pdf",
			size: 1_840_000,
			kind: "file",
		},
		() => text("A stand-in for the campaign's brand guidelines."),
	),
	file({ id: "att-sheet", name: "image-model-pricing.csv", type: "text/csv", size: 4_200, kind: "file" }, () =>
		text(
			"model,provider,price per image\ngpt-image-1,OpenAI,0.04\nimagen-4,Google,0.04\nflux-1.1-pro,Black Forest Labs,0.04\n",
		),
	),
	file({ id: "att-config", name: "generate.config.ts", type: "text/plain", size: 1_100, kind: "file" }, () =>
		text('export default { models: ["gpt-image-1", "imagen-4", "flux-1.1-pro"], size: "1536x1024" };\n'),
	),
	file({ id: "att-pasted", name: "pasted-text.txt", type: "text/plain", size: 860, kind: "text" }, () =>
		text("Keep the night palette, the lit windows and the empty desks. No people."),
	),
];

/** A recorded attachment's content, as `GET /v1/attachments/:id` answers it. */
export async function readRecordedAttachment(attachmentId: string, signal?: AbortSignal): Promise<AttachmentContent> {
	await new Promise((resolve) => setTimeout(resolve, 120));
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	const found = FILES[attachmentId];
	if (found === undefined) throw new ApiError("not_found", "There's no such attachment.");
	return found.read();
}
