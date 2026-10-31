import type { PresentedFile } from "@kantel/protocol";
import { describe, expect, it } from "vitest";
import type { WorkspaceFile } from "../api/client.ts";
import { createImagePreviews } from "./image-previews.ts";

const file = (path: string, mimeType = "image/png"): PresentedFile => ({
	workspaceId: "ws-1",
	path,
	name: path.split("/").at(-1) ?? path,
	mimeType,
	size: 3,
});

const png: WorkspaceFile = { content: new Uint8Array([1, 2, 3]), contentType: "image/png", version: 1 };

function setup(answer: (path: string) => Promise<WorkspaceFile>) {
	const reads: string[] = [];
	const revoked: string[] = [];
	let made = 0;
	const previews = createImagePreviews(
		(presented) => {
			reads.push(presented.path);
			return answer(presented.path);
		},
		() => `blob:${++made}`,
		(url) => revoked.push(url),
	);
	return { previews, reads, revoked };
}

describe("createImagePreviews", () => {
	it("reads each image once, however many cards ask, and frees the URLs when the session closes", async () => {
		const { previews, reads, revoked } = setup(() => Promise.resolve(png));
		const [a, b] = await Promise.all([previews.url(file("images/a.png")), previews.url(file("images/a.png"))]);
		expect(a).toBe("blob:1");
		expect(b).toBe("blob:1");
		expect(reads).toEqual(["images/a.png"]);
		previews.dispose();
		expect(revoked).toEqual(["blob:1"]);
	});

	it("gives the panel the card's read and URL: joined while it is under way, at once once it has finished", async () => {
		let answer: (file: WorkspaceFile) => void = () => {};
		const { previews, reads } = setup(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		const image = file("images/a.png");
		const card = previews.url(image);
		expect(previews.shown(image)).toBeUndefined();
		const panel = previews.picture(image);
		answer({ ...png, digest: "abc" });
		expect(await card).toBe("blob:1");
		const opened = await panel;
		expect(opened?.url).toBe("blob:1");
		expect(opened?.digest).toBe("abc");
		expect(previews.shown(image)).toBe(opened);
		expect(reads).toEqual(["images/a.png"]);
		previews.dispose();
		expect(previews.shown(image)).toBeUndefined();
	});

	it("has no preview for a file that isn't an image, and asks again after a read fails", async () => {
		let fail = true;
		const { previews, reads } = setup((path) =>
			path.endsWith(".txt")
				? Promise.resolve({ ...png, contentType: "text/plain" })
				: fail
					? Promise.reject(new Error("too_large"))
					: Promise.resolve(png),
		);
		expect(await previews.url(file("notes.txt", "text/plain"))).toBeUndefined();
		expect(await previews.url(file("images/b.png"))).toBeUndefined();
		fail = false;
		expect(await previews.url(file("images/b.png"))).toBe("blob:1");
		expect(reads).toEqual(["notes.txt", "images/b.png", "images/b.png"]);
	});
});
