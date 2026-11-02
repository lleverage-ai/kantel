/**
 * Compares what a Kantel Sal worker and a local Sal worker were given for the same tasks: the output of
 * `kantel-sal.ts` against one `sal-local.ts` output per task. Prints a Markdown report and exits 1 on any difference
 * in the recalled concepts, the recall text, the skill set, a skill's SKILL.md or package, or the entries of the
 * prompt's skill block (locations aside: Kantel mounts skills at /skills). The entries' order is reported but never
 * fails the run: Pi lists them in file system order, which no pinned tree records.
 *
 *   node examples/sal-worker/scripts/parity.ts --kantel kantel.json --sal TASK-1=sal-1.json --sal TASK-2=sal-2.json
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

interface Side {
	readonly recall: {
		readonly concepts: readonly { readonly id: string; readonly reason: string }[];
		readonly skipped: readonly { readonly id: string; readonly reason: string }[];
		readonly profileDropped: readonly string[];
		readonly bytes: number;
		readonly text: string;
	};
	readonly skills: readonly { readonly name: string; readonly sha256: string; readonly digest: string }[];
	readonly skillsPrompt: string;
	readonly memoryRevision: string | null;
}

const { values } = parseArgs({
	options: { kantel: { type: "string" }, sal: { type: "string", multiple: true } },
});
if (values.kantel === undefined || values.sal === undefined) throw new Error("--kantel and --sal are required");
const kantel = JSON.parse(readFileSync(values.kantel, "utf8")) as { tasks: (Side & { task: string })[] };
const local = new Map(
	values.sal.map((pair) => {
		const [task, path] = pair.split("=") as [string, string];
		return [task, JSON.parse(readFileSync(path, "utf8")) as Side];
	}),
);

const withoutLocations = (prompt: string) => prompt.replace(/<location>[^<]*<\/location>/g, "<location/>");
/**
 * The prompt block as its text around the skills and its `<skill>` entries, sorted. Pi lists skills in the order its
 * file system returns directory entries, which no pinned tree records, so the order is reported apart.
 */
const promptParts = (prompt: string) => {
	const entries = withoutLocations(prompt).match(/ {2}<skill>[\s\S]*?<\/skill>\n?/g) ?? [];
	const frame = entries.reduce((text, entry) => text.replace(entry, ""), withoutLocations(prompt));
	const order = entries.map((entry) => /<name>([^<]*)<\/name>/.exec(entry)?.[1] ?? "");
	return { frame, entries: entries.map((entry) => entry.replace(/\n$/, "")).sort(), order };
};
const ids = (list: readonly { readonly id: string; readonly reason: string }[]) =>
	list.map((item) => `${item.id}:${item.reason}`).join(",");

let failed = false;
const lines = [
	"| Task | Memory ref | Recalled (profile + match) | Recall text | Skipped | Skills | SKILL.md / package | Prompt block | Prompt order |",
	"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];
const details: string[] = [];
for (const ours of kantel.tasks) {
	const theirs = local.get(ours.task);
	if (theirs === undefined) throw new Error(`no Sal output for ${ours.task}`);
	const same = (ok: boolean, label: string, detail: () => string) => {
		if (!ok) {
			failed = true;
			details.push(`- ${ours.task} ${label}: ${detail()}`);
		}
		return ok ? "same" : "**differs**";
	};
	const profile = theirs.recall.concepts.filter((concept) => concept.reason === "profile").length;
	const matched = theirs.recall.concepts.length - profile;
	const recalled = same(ids(ours.recall.concepts) === ids(theirs.recall.concepts), "recalled", () =>
		JSON.stringify({ kantel: ids(ours.recall.concepts), sal: ids(theirs.recall.concepts) }),
	);
	const text = same(ours.recall.text === theirs.recall.text, "recall text", () => {
		const at = [...ours.recall.text].findIndex((char, index) => char !== theirs.recall.text[index]);
		return `first difference at ${at}: ${JSON.stringify(ours.recall.text.slice(at, at + 80))} vs ${JSON.stringify(theirs.recall.text.slice(at, at + 80))}`;
	});
	// Skip reasons name a status: Kantel has no `deprecated`, so Sal's deprecated concepts read `forgotten`.
	const skipped = same(
		ours.recall.skipped.map((item) => item.id).join(",") === theirs.recall.skipped.map((item) => item.id).join(","),
		"skipped",
		() => JSON.stringify({ kantel: ours.recall.skipped, sal: theirs.recall.skipped }),
	);
	const names = (side: Side) => side.skills.map((skill) => skill.name).sort();
	const skillSet = same(names(ours).join(",") === names(theirs).join(","), "skills", () =>
		JSON.stringify({
			onlyKantel: names(ours).filter((name) => !names(theirs).includes(name)),
			onlySal: names(theirs).filter((name) => !names(ours).includes(name)),
		}),
	);
	const byName = new Map(theirs.skills.map((skill) => [skill.name, skill]));
	const contentDiffs = ours.skills.filter((skill) => {
		const other = byName.get(skill.name);
		return other !== undefined && (other.sha256 !== skill.sha256 || other.digest !== skill.digest);
	});
	const content = same(contentDiffs.length === 0, "skill content", () =>
		contentDiffs.map((skill) => skill.name).join(", "),
	);
	const oursPrompt = promptParts(ours.skillsPrompt);
	const theirsPrompt = promptParts(theirs.skillsPrompt);
	const prompt = same(
		oursPrompt.frame === theirsPrompt.frame && oursPrompt.entries.join("\n") === theirsPrompt.entries.join("\n"),
		"prompt",
		() =>
			JSON.stringify({
				frame: oursPrompt.frame === theirsPrompt.frame,
				onlyKantel: oursPrompt.entries.filter((entry) => !theirsPrompt.entries.includes(entry)),
				onlySal: theirsPrompt.entries.filter((entry) => !oursPrompt.entries.includes(entry)),
			}),
	);
	// Informational: never fails the run.
	const order = oursPrompt.order.join(",") === theirsPrompt.order.join(",") ? "same" : "differs (file system order)";
	const ref = same(
		ours.memoryRevision === theirs.memoryRevision,
		"memory ref",
		() => `${ours.memoryRevision} vs ${theirs.memoryRevision}`,
	);
	lines.push(
		`| ${ours.task} | ${ref} | ${recalled} (${profile} + ${matched}) | ${text} (${theirs.recall.bytes} bytes) | ${skipped} (${theirs.recall.skipped.length}) | ${skillSet} (${theirs.skills.length}) | ${content} | ${prompt} (${theirsPrompt.entries.length}) | ${order} |`,
	);
}
process.stdout.write(
	`${[...lines, "", ...(details.length === 0 ? ["No differences in what is compared; the prompt order is reported above."] : details)].join("\n")}\n`,
);
process.exit(failed ? 1 : 0);
