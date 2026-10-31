import type { TranscriptItem, UserAttachment } from "@kantel/protocol";
import { presentedKey } from "@kantel/ui";
import { describe, expect, it } from "vitest";
import { fileOfHash, hashWithFile } from "./preview-url.ts";
import { attachmentAsPresented, openAttachmentId, sentAttachmentFiles } from "./sent-attachments.ts";

const image: UserAttachment = { id: "att-1", name: "image.jpg", type: "image/jpeg", size: 612_689, kind: "image" };
const notes: UserAttachment = { id: "att-2", name: "notes.txt", type: "text/plain", size: 12, kind: "text" };
const user = (id: string, attachments?: UserAttachment[]): TranscriptItem => ({
	kind: "user",
	id,
	at: 1,
	text: "Put a lion in the background of this",
	via: "prompt",
	...(attachments === undefined ? {} : { attachments }),
});

describe("sentAttachmentFiles", () => {
	it("lists every file sent with a message once, in the order sent", () => {
		const files = sentAttachmentFiles([
			user("u1", [image]),
			{ kind: "assistant", id: "a1", at: 2, text: "Done.", streaming: false },
			user("u2"),
			user("u3", [notes, image]),
		]);
		expect(files.map((file) => file.name)).toEqual(["image.jpg", "notes.txt"]);
		expect(files.map(openAttachmentId)).toEqual(["att-1", "att-2"]);
	});

	// A page reloaded to recover from a stale chunk keeps its `#file=`; the attachment it names opens again (TASK-4265).
	it("finds the attachment a #file= link names", () => {
		const hash = hashWithFile("", presentedKey(attachmentAsPresented(image)));
		const linked = fileOfHash(hash);
		const found = sentAttachmentFiles([user("u1", [image])]).find((file) => presentedKey(file) === linked);
		expect(found).toEqual(attachmentAsPresented(image));
	});
});
