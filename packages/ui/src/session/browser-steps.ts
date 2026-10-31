import type { ToolItem, TranscriptItem } from "@harbour/protocol";
import { duration } from "../primitives/format.ts";
import { toolMatches } from "./tool-renderer-model.ts";

// What a browser's calls say, in words: each step by what it did, from its result (the `Did:` line `@harbour/browser`
// writes, the page's `URL:` and `Title:`), and a run of them by how it went. The browser's entry in the tool renderer
// registry (tool-renderers.tsx) shows these; the session's API carries the calls as they were made.

/** The browser's tools (`@harbour/browser`), as the registry names them: every tool whose name starts `browser_`. */
export const BROWSER_TOOLS: readonly string[] = ["browser_*"];

/** A call to one of the browser's tools (`browser_request`, `browser_open`, `browser_act`, ...). */
export function isBrowserCall(item: TranscriptItem): item is ToolItem {
	return item.kind === "tool" && toolMatches(BROWSER_TOOLS, item.name);
}

/** A page's host as a person names it: "kayak.co.uk" for https://www.kayak.co.uk/flights. */
export function siteOf(url: unknown): string | undefined {
	if (typeof url !== "string") return undefined;
	try {
		const host = new URL(url).host;
		return host === "" ? undefined : host.replace(/^www\./, "");
	} catch {
		return undefined;
	}
}

const line = (output: string, name: string): string | undefined =>
	output.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim() || undefined;

/** The first “quoted” name in a step's description: “Reject all” in `click button “Reject all”, in: “…”`. */
const quoted = (text: string): string | undefined => text.match(/“([^”]*)”/)?.[0];

type Args = { readonly [key: string]: unknown };
const argsOf = (item: ToolItem): Args =>
	typeof item.args === "object" && item.args !== null ? (item.args as Args) : {};

/** The element a step names, as the agent wrote it: "[4]". */
const elementOf = (args: Args): string => (typeof args.element === "string" ? args.element : "an element");

/** What a step set out to do, from its arguments: "click [4]", "go to kayak.co.uk". */
function intent(item: ToolItem): string {
	const args = argsOf(item);
	const site = siteOf(args.url);
	switch (item.name) {
		case "browser_request":
			return "get a browser";
		case "browser_open":
			return site === undefined ? "open a browser" : `open ${site}`;
		case "browser_screenshot":
			return "take a screenshot";
		case "browser_close":
			return "close the browser";
		case "browser_run":
			return site === undefined ? "run a goal in the browser" : `run a goal on ${site}`;
		case "browser_act":
			switch (args.action) {
				case "goto":
					return site === undefined ? "go to the page" : `go to ${site}`;
				case "look":
					return "read the page";
				case "click":
					return `click ${elementOf(args)}`;
				case "fill":
					return `type into ${elementOf(args)}`;
				case "select":
					return `choose an option in ${elementOf(args)}`;
				case "check":
					return `tick ${elementOf(args)}`;
				case "press":
					return typeof args.key === "string" ? `press ${args.key}` : "press a key";
				case "scroll":
					return "scroll the page";
				case "wait":
					return "wait for the page";
				default:
					return "use the browser";
			}
		default:
			return "use the browser";
	}
}

/** A step's own account of what it did (`Did: click button “Reject all”`), in past-tense words. */
function didWords(did: string, page: string | undefined): string {
	const [verb = "", ...words] = did.split(" ");
	const rest = words.join(" ");
	const target = quoted(rest);
	switch (verb) {
		case "click":
			return `Clicked ${target ?? rest}`;
		case "fill": {
			const value = rest.match(/\u2190 (“[^”]*”)/)?.[1];
			return value === undefined ? `Typed into ${target ?? rest}` : `Typed ${value} into ${target ?? "a field"}`;
		}
		case "select": {
			const value = rest.match(/\u2190 (“[^”]*”)/)?.[1];
			return value === undefined ? `Chose an option in ${target ?? rest}` : `Chose ${value} in ${target ?? "a list"}`;
		}
		case "check":
			return `Ticked ${target ?? rest}`;
		case "press":
			return `Pressed ${rest || "a key"}`;
		case "goto":
			return `Went to ${page ?? siteOf(rest) ?? rest}`;
		case "scroll":
			return "Scrolled down";
		case "wait":
			return "Waited for the page";
		default:
			return did.charAt(0).toUpperCase() + did.slice(1);
	}
}

/** Whether a step failed: the call did, or the browser said its action didn't succeed (`Failed:`). */
export function browserStepFailed(item: ToolItem): boolean {
	if (item.status === "error" || item.status === "interrupted") return true;
	return item.status === "done" && /^Failed: /m.test(item.output ?? "");
}

/**
 * A browser step in words, naming its target from its result once done: "Clicked “Reject all”", "Read “MAN to AMS,
 * 16/12 – 19/12”", "Went to kayak.co.uk". While it runs, the words the session gave it from its arguments ("Reading
 * the page"); failed, what it set out to do ("Couldn't click [4]").
 */
export function browserStepLabel(item: ToolItem): string {
	if (item.status === "running") return item.label;
	if (item.status !== "done") return `Couldn't ${intent(item)}`;
	const output = item.output ?? "";
	const page = siteOf(line(output, "URL"));
	const title = line(output, "Title");
	const failed = line(output, "Failed");
	if (failed !== undefined) {
		const [verb = "", ...words] = failed.split(" ");
		const rest = words.join(" ");
		return `Couldn't ${verb === "goto" ? "go to" : verb} ${quoted(rest) ?? siteOf(rest) ?? rest}`.trim();
	}
	const did = line(output, "Did");
	switch (item.name) {
		case "browser_request": {
			const sites = output.match(/allowed a browser for (.*?)\.(?:\s|$)/)?.[1];
			if (sites === undefined) return item.label;
			const names = sites.split(/,\s*/).map((site) => site.replace(/^www\./, ""));
			const last = names.pop();
			return `Got a browser for ${names.length === 0 ? last : `${names.join(", ")} and ${last}`}`;
		}
		case "browser_open":
			return page === undefined ? "Opened a browser" : `Opened ${page}`;
		case "browser_screenshot": {
			const shot = siteOf(output.match(/^Screenshot of (\S+)/m)?.[1]);
			return shot === undefined ? "Took a screenshot" : `Took a screenshot of ${shot}`;
		}
		case "browser_close":
			return "Closed the browser";
		case "browser_run": {
			// Goal mode: how the run ended (packages/browser's renderRun), where, and in how many steps.
			const ending = /^The goal is met\./m.test(output)
				? "Met the goal"
				: /^It handed back to you/m.test(output)
					? "Handed back"
					: /^It stopped where you said/m.test(output)
						? "Stopped where asked"
						: /^It ran out of steps/m.test(output)
							? "Ran out of steps"
							: "Ran a goal";
			const steps = output.match(/^Steps \((\d+),/m)?.[1];
			return `${ending}${page === undefined ? "" : ` on ${page}`}${steps === undefined ? "" : ` in ${steps} step${steps === "1" ? "" : "s"}`}`;
		}
	}
	if (did !== undefined) return didWords(did, page);
	if (argsOf(item).action === "look") return title === undefined ? "Read the page" : `Read “${title}”`;
	return item.label;
}

/**
 * Why a step failed, in a line: its error with the tool's own prefixes and the advice to the agent taken off, and
 * addresses cut to their host ("No element [4] on consent.google.com"). Undefined for a step that didn't fail.
 */
export function browserStepReason(item: ToolItem): string | undefined {
	if (!browserStepFailed(item)) return undefined;
	if (item.status === "interrupted") return "Stopped before it finished";
	const output = item.output ?? "";
	if (item.status === "done") return line(output, "Failed") === undefined ? undefined : "The page didn't change";
	const reason = (output.split("\n").find((text) => text.trim() !== "") ?? "")
		.replace(/^[\w.]+ failed(?: \([^)]*\))?: /, "")
		.replace(/^The browser: /, "")
		.replace(/https?:\/\/\S+?(?=[;,]?(?:\s|$))/g, (url) => siteOf(url) ?? url)
		.replace(/;\s*look again\.?$/, "")
		.trim();
	if (reason === "") return undefined;
	return reason.length > 160 ? `${reason.slice(0, 159)}…` : reason;
}

/** Where a run's calls left the browser, as a site: the newest page any of them named. */
function lastSite(calls: readonly ToolItem[]): string | undefined {
	for (let index = calls.length - 1; index >= 0; index--) {
		const call = calls[index];
		if (call === undefined) continue;
		const output = call.output ?? "";
		const site =
			siteOf(line(output, "URL")) ??
			siteOf(output.match(/^Screenshot of (\S+)/m)?.[1]) ??
			(call.name === "browser_open" || argsOf(call).action === "goto" ? siteOf(argsOf(call).url) : undefined);
		if (site !== undefined) return site;
	}
	return undefined;
}

/**
 * A browsing run's line. While it runs: "Browsing kayak.co.uk" and the step it is on. Once done, how it went:
 * "Browsed kayak.co.uk for 2m 37s", "15 steps", and how many failed.
 */
export function browsingRunSummary(
	calls: readonly ToolItem[],
	{ running }: { readonly running: boolean },
): { title: string; detail?: string; failed?: number } {
	const site = lastSite(calls);
	if (running) {
		const current = calls.findLast((call) => call.status === "running") ?? calls.at(-1);
		return {
			title: site === undefined ? "Browsing" : `Browsing ${site}`,
			...(current === undefined ? {} : { detail: browserStepLabel(current) }),
		};
	}
	let start = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	for (const call of calls) {
		start = Math.min(start, call.at);
		end = Math.max(end, call.endedAt ?? call.at);
	}
	// Under a second says nothing, and is what a snapshot without the calls' times shows: leave it out.
	const took = end - start < 1000 ? "" : ` for ${duration(end - start)}`;
	const failed = calls.filter(browserStepFailed).length;
	return {
		title: `Browsed${site === undefined ? "" : ` ${site}`}${took}`,
		detail: calls.length === 1 ? "1 step" : `${calls.length} steps`,
		...(failed === 0 ? {} : { failed }),
	};
}
