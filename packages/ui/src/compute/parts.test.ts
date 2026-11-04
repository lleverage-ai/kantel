import { describe, expect, it } from "vitest";
import { cellText, type TextNode } from "./parts.tsx";

const text = (value: string): TextNode => ({ nodeType: 3, textContent: value, childNodes: [] });
const element = (children: TextNode[], attributes: string[] = []): TextNode => ({
	nodeType: 1,
	textContent: children.map((child) => child.textContent ?? "").join(""),
	childNodes: children,
	hasAttribute: (name) => attributes.includes(name),
});
const none = () => element([text("–")], ["data-none"]);

describe("a phone card's empty cells", () => {
	it("reads a cell holding only the None placeholder as empty", () => {
		expect(cellText(element([none()])).trim()).toBe("");
		expect(cellText(element([text("\n\t"), none(), text(" ")])).trim()).toBe("");
	});

	it("keeps a value that is itself a dash", () => {
		expect(cellText(element([text("-")]))).toBe("-");
		expect(cellText(element([element([text("---")])]))).toBe("---");
		expect(cellText(element([element([text("–")], ["class"])]))).toBe("–");
	});

	it("reads the rest of a cell beside a placeholder", () => {
		expect(cellText(element([none(), element([text("by Tom")])]))).toBe("by Tom");
	});
});
