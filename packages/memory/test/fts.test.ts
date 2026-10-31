/**
 * The portable full-text index against SQLite's own FTS5 (`node:sqlite`): the same terms for the same text, and the
 * same `bm25()` scores and order for the same OR query, so recall ranks as an FTS5 index does.
 */
import { DatabaseSync } from "node:sqlite";
import { createFtsIndex, ftsTerms, porterStem, searchFts, unicode61Tokens } from "@kantel/memory";
import { describe, expect, it } from "vitest";

function sqliteTerms(texts: readonly string[]): string[][] {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize = 'porter unicode61')");
		db.exec("CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance')");
		const insert = db.prepare("INSERT INTO t(rowid, body) VALUES (?, ?)");
		for (const [index, text] of texts.entries()) insert.run(index + 1, text);
		const rows = db.prepare("SELECT doc, term, offset FROM v").all() as { doc: number; term: string; offset: number }[];
		const terms = texts.map(() => [] as string[]);
		for (const row of rows) terms[row.doc - 1]![row.offset] = row.term;
		return terms;
	} finally {
		db.close();
	}
}

const ENGLISH = [
	"caresses ponies ties caress cats feed agreed plastered bled motoring sing conflated troubled sized hopping tanned",
	"falling hissing fizzed failing filing happy sky relational conditional rational valenci hesitanci digitizer",
	"conformabli radicalli differentli vileli analogousli vietnamization predication operator feudalism decisiveness",
	"hopefulness callousness formaliti sensitiviti sensibiliti triplicate formative formalize electriciti electrical",
	"hopeful goodness revival allowance inference airliner gyroscopic adjustable defensible irritant replacement",
	"adjustment dependent adoption homologou communism activate angulariti homologous effective bowdlerize probate",
	"rate cease controll roll generalizations oscillators agreement eed bed reed exceed succeed proceed yes yesterday",
	"Kantel's recall: BM25 over FTS5; Sal's workers recalled 5 concepts (4 KiB) — don't co-op e-mail U.S.A. v2.0.1",
];

const UNICODE = [
	"Café naïve résumé Ærøskøbing ŒUVRE straße İstanbul ΣΊΣΥΦΟΣ Привет 日本語テキスト 𝐁old ①②③ x² ǅungla",
	"a\u0310b c\u0301d e\u0308f ﬁne Ⅻ ＡＢＣ 🟠 emoji 🎉 mixed🙂text ‐hyphen‑ non‑breaking",
];

describe("ftsTerms", () => {
	it("tokenises and stems English text as FTS5's porter unicode61 does", () => {
		const expected = sqliteTerms(ENGLISH);
		for (const [index, text] of ENGLISH.entries()) expect(ftsTerms(text), text).toEqual(expected[index]);
	});

	it("folds case and diacritics and splits on separators as unicode61 does", () => {
		const expected = sqliteTerms(UNICODE);
		for (const [index, text] of UNICODE.entries()) expect(ftsTerms(text), text).toEqual(expected[index]);
	});

	it("classifies every code point of the first three planes as SQLite's tables do", { timeout: 60_000 }, () => {
		const texts: string[] = [];
		for (let block = 0x80; block < 0x30000; block += 0x1000) {
			const parts: string[] = [];
			for (let code = block; code < block + 0x1000; code += 1) {
				// Surrogates are not characters; U+FFFE and U+FFFF differ between SQLite versions (see below).
				if ((code >= 0xd800 && code < 0xe000) || code === 0xfffe || code === 0xffff) continue;
				const character = String.fromCodePoint(code);
				parts.push(`x${character}y A${character}`);
			}
			texts.push(parts.join(" "));
		}
		const expected = sqliteTerms(texts);
		texts.forEach((text, index) => {
			const actual = ftsTerms(text);
			if (JSON.stringify(actual) !== JSON.stringify(expected[index])) {
				const at = actual.findIndex((term, position) => term !== expected[index]![position]);
				expect(actual.slice(at, at + 3), `block ${index}`).toEqual(expected[index]!.slice(at, at + 3));
			}
		});
	});

	it("leaves tokens shorter than three or longer than 64 bytes unstemmed", () => {
		expect(porterStem("is")).toBe("is");
		const long = `${"a".repeat(62)}ing`;
		expect(porterStem(long)).toBe(long);
		expect(unicode61Tokens("Ünïcödé")).toEqual(["unicode"]);
	});

	it("separates tokens at U+FFFE and U+FFFF, as SQLite to 3.53 (Bun, Node 24) does", () => {
		expect(ftsTerms("x\ufffey A\uffff")).toEqual(["x", "y", "a"]);
	});

	it("keeps a very long token whole, as SQLite does", () => {
		const long = "x".repeat(1_000_000);
		expect(ftsTerms(`a ${long} b`)).toEqual(["a", long, "b"]);
	});
});

describe("searchFts", () => {
	const columns = ["id", "title", "description", "tags", "body"];
	const weights = [4, 4, 2.5, 3, 1];
	const rows = [
		[
			"projects harbour vault codes",
			"Vault binding codes",
			"How approvals bind",
			"vault approvals",
			"Every vault write needs the matching binding code.",
		],
		[
			"personal pr review timing",
			"PR review timing",
			"When Tom reviews",
			"reviews",
			"Tom reviews pull requests after lunch, never before ten.",
		],
		[
			"projects sal recall ladder",
			"Recall ladder",
			"BM25 then a model",
			"recall memory",
			"Recall is BM25 over FTS5, then a small model reranks when unsure.",
		],
		[
			"projects harbour skills mount",
			"Skills mount",
			"Read-only skills",
			"skills mounts",
			"Skills mount read-only at /skills with pinned revisions per session.",
		],
		[
			"personal deploy windows",
			"Deploy windows",
			"",
			"deploys",
			"Deploy on weekday mornings; never deploy on Fridays after noon.",
		],
		[
			"projects sal memory writer",
			"Memory writer",
			"One serial writer",
			"memory writes",
			"Every memory write goes through one serial writer with paraphrase checks.",
		],
	];

	function sqliteSearch(query: string, limit: number): { key: string; score: number }[] {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec(`CREATE VIRTUAL TABLE c USING fts5(key UNINDEXED, ${columns.join(", ")}, tokenize = 'porter unicode61')`);
			const insert = db.prepare(`INSERT INTO c VALUES (?, ${columns.map(() => "?").join(", ")})`);
			for (const [index, row] of rows.entries()) insert.run(`row${index}`, ...row);
			return db
				.prepare(
					`SELECT key, -bm25(c, 0, ${weights.join(", ")}) AS score FROM c WHERE c MATCH ? ORDER BY score DESC LIMIT ?`,
				)
				.all(query, limit) as { key: string; score: number }[];
		} finally {
			db.close();
		}
	}

	const index = createFtsIndex(rows.map((row, position) => ({ key: `row${position}`, columns: row })));

	for (const words of [
		["vault"],
		["reviews", "lunch"],
		["recall", "memory", "writer"],
		["skills", "pinned", "session", "mount"],
		["deploy", "fridays", "weekday", "mornings", "never"],
		["binding", "code", "writes", "serial", "nothing"],
		["read-only", "skills"],
		["serial writer", "pull requests", "memory"],
		["missing"],
	]) {
		it(`scores ${words.join(" ")} as bm25() does`, () => {
			const expected = sqliteSearch(words.map((word) => `"${word}"`).join(" OR "), 60);
			const actual = searchFts(index, words, { weights, limit: 60 });
			expect(actual.map((hit) => hit.key)).toEqual(expected.map((hit) => hit.key));
			for (const [position, hit] of actual.entries()) expect(hit.score).toBeCloseTo(expected[position]!.score, 9);
		});
	}

	it("counts a phrase of several terms only where they are consecutive", () => {
		const phraseIndex = createFtsIndex([
			{ key: "a", columns: ["read only mount"] },
			{ key: "b", columns: ["only read the mount"] },
		]);
		expect(searchFts(phraseIndex, ["read-only"]).map((hit) => hit.key)).toEqual(["a"]);
		expect(searchFts(phraseIndex, ["!!"])).toEqual([]);
		expect(searchFts(createFtsIndex([]), ["read"])).toEqual([]);
	});
});
