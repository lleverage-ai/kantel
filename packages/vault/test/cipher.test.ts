import { createAesGcmCipher, randomCipherKey } from "@harbour/vault/cipher";
import { describe, expect, it } from "vitest";

const binding = { itemId: "item-1", valueVersion: 1 };

describe("createAesGcmCipher", () => {
	it("seals into a versioned envelope naming the key, with a fresh IV each time, and opens it again", async () => {
		const cipher = createAesGcmCipher({ key: randomCipherKey(), keyId: "k2026" });
		const first = await cipher.seal("value-1", binding);
		const second = await cipher.seal("value-1", binding);
		expect(first).toMatch(/^hv1\.k2026\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
		expect(first).not.toBe(second);
		expect(first).not.toContain("value-1");
		expect(await cipher.open(first, binding)).toBe("value-1");
		expect(await cipher.open(second, binding)).toBe("value-1");
	});

	it("refuses a sealed value copied onto another item or another value version", async () => {
		const cipher = createAesGcmCipher({ key: randomCipherKey() });
		const sealed = await cipher.seal("value-1", binding);
		await expect(cipher.open(sealed, { itemId: "item-2", valueVersion: 1 })).rejects.toMatchObject({
			code: "unavailable",
		});
		await expect(cipher.open(sealed, { itemId: "item-1", valueVersion: 2 })).rejects.toMatchObject({
			code: "unavailable",
		});
	});

	it("refuses a value sealed under another key, a tampered one and an unknown envelope", async () => {
		const key = randomCipherKey();
		const cipher = createAesGcmCipher({ key });
		const sealed = await cipher.seal("value-1", binding);
		await expect(createAesGcmCipher({ key: randomCipherKey() }).open(sealed, binding)).rejects.toMatchObject({
			code: "unavailable",
		});
		const parts = sealed.split(".");
		const flipped = parts[3]!.startsWith("A") ? `B${parts[3]!.slice(1)}` : `A${parts[3]!.slice(1)}`;
		await expect(cipher.open([...parts.slice(0, 3), flipped].join("."), binding)).rejects.toMatchObject({
			code: "unavailable",
		});
		await expect(cipher.open(`hv0.${parts.slice(1).join(".")}`, binding)).rejects.toMatchObject({
			code: "unavailable",
		});
	});

	it("takes the key as base64 too, and the same key gives the same default key ID", async () => {
		const key = randomCipherKey();
		const base64 = btoa(String.fromCharCode(...key));
		const sealed = await createAesGcmCipher({ key }).seal("value-1", binding);
		expect(await createAesGcmCipher({ key: base64 }).open(sealed, binding)).toBe("value-1");
		expect(() => createAesGcmCipher({ key: new Uint8Array(16) })).toThrow(expect.objectContaining({ code: "invalid" }));
		expect(() => createAesGcmCipher({ key, keyId: "has space" })).toThrow(expect.objectContaining({ code: "invalid" }));
	});
});
