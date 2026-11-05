// What a person is called: their name, else their email, else their user ID, never an ID while either is known.
import { describe, expect, it } from "vitest";
import { isPlaceholderName, personName } from "../src/names.ts";

const ID = "usr_4e473b3d-2b96-4bbf-9427-98be4e40ecff";

describe("a person's name", () => {
	it("is their name when they have a real one", () => {
		expect(personName({ userId: ID, name: "Alex", email: "alex@example.com" })).toBe("Alex");
		expect(personName({ userId: ID, name: "  Alex Smith ", email: "alex@example.com" })).toBe("Alex Smith");
	});

	it("is their email when the name is empty or only a user ID", () => {
		for (const name of [undefined, "", "  ", ID, "usr_someone_else"]) {
			expect(personName({ userId: ID, name, email: "alex@example.com" })).toBe("alex@example.com");
		}
	});

	it("is their user ID only when nothing better is known", () => {
		expect(personName({ userId: ID, name: ID })).toBe(ID);
		expect(personName({ userId: ID, email: "" })).toBe(ID);
	});

	it("takes an ID, its own or any usr_, or nothing at all, for no name", () => {
		expect(isPlaceholderName(undefined)).toBe(true);
		expect(isPlaceholderName(" ")).toBe(true);
		expect(isPlaceholderName("abc", "abc")).toBe(true);
		expect(isPlaceholderName(ID)).toBe(true);
		expect(isPlaceholderName("Alex", ID)).toBe(false);
		expect(isPlaceholderName("alex@example.com", ID)).toBe(false);
	});
});
