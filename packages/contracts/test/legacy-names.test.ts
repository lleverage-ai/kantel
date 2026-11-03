// The names from before the rename that Kantel still accepts: headers and token prefixes.

import { describe, expect, it } from "vitest";
import {
	hasTokenPrefix,
	legacyHeaderName,
	readHeader,
	TOKEN_PREFIXES,
	withLegacyHeaders,
} from "../src/legacy-names.ts";

describe("legacyHeaderName", () => {
	it("gives a kantel-* or x-kantel-* header its harbour-* name, and leaves any other alone", () => {
		expect(legacyHeaderName("Kantel-Organisation")).toBe("harbour-organisation");
		expect(legacyHeaderName("kantel-request-id")).toBe("harbour-request-id");
		expect(legacyHeaderName("x-kantel-agent-token")).toBe("x-harbour-agent-token");
		expect(legacyHeaderName("authorization")).toBeUndefined();
		expect(legacyHeaderName("x-kantelish")).toBeUndefined();
	});
});

describe("readHeader", () => {
	it("reads today's name first, and the one before the rename only when today's is absent", () => {
		expect(readHeader(new Headers({ "kantel-organisation": "org_a" }), "kantel-organisation")).toBe("org_a");
		expect(readHeader(new Headers({ "Harbour-Organisation": "org_b" }), "Kantel-Organisation")).toBe("org_b");
		const both = new Headers({ "kantel-organisation": "org_a", "harbour-organisation": "org_b" });
		expect(readHeader(both, "kantel-organisation")).toBe("org_a");
		// Empty is a value: it isn't filled from the old name.
		const empty = new Headers({ "kantel-request-id": "", "harbour-request-id": "r1" });
		expect(readHeader(empty, "kantel-request-id")).toBe("");
		expect(readHeader(new Headers({ "x-harbour-forwarded": "1" }), "x-kantel-forwarded")).toBe("1");
		expect(readHeader(new Headers(), "kantel-version")).toBeNull();
		expect(readHeader(new Headers({ "harbour-authorization": "x" }), "authorization")).toBeNull();
	});
});

describe("withLegacyHeaders", () => {
	it("adds each kantel-* header under its old name too, without touching the rest or overriding one set", () => {
		expect(
			withLegacyHeaders({
				"content-type": "application/json",
				"kantel-signature": "t=1,v1=ab",
				"x-kantel-forwarded": "1",
				"harbour-host-id": "kept",
				"kantel-host-id": "h1",
			}),
		).toEqual({
			"content-type": "application/json",
			"kantel-signature": "t=1,v1=ab",
			"harbour-signature": "t=1,v1=ab",
			"x-kantel-forwarded": "1",
			"x-harbour-forwarded": "1",
			"harbour-host-id": "kept",
			"kantel-host-id": "h1",
		});
	});
});

describe("token prefixes", () => {
	it("takes each kind's prefix today and before the rename, and no other kind's", () => {
		expect(TOKEN_PREFIXES).toEqual({
			apiKey: { current: "ktk_", legacy: "hbr_" },
			session: { current: "kts_", legacy: "hbs_" },
			tunnel: { current: "ktt_", legacy: "hbt_" },
		});
		expect(hasTokenPrefix("ktk_a", "apiKey")).toBe(true);
		expect(hasTokenPrefix("hbr_a", "apiKey")).toBe(true);
		expect(hasTokenPrefix("hbs_a", "apiKey")).toBe(false);
		expect(hasTokenPrefix("kts_a", "session")).toBe(true);
		expect(hasTokenPrefix("hbs_a", "session")).toBe(true);
		expect(hasTokenPrefix("ktk_a", "session")).toBe(false);
		expect(hasTokenPrefix("ktt_a", "tunnel")).toBe(true);
		expect(hasTokenPrefix("hbt_a", "tunnel")).toBe(true);
		expect(hasTokenPrefix("HBT_a", "tunnel")).toBe(false);
	});
});
