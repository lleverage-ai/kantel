/**
 * `PromptRules` on SQL (`@kantel/sql`): Postgres self-hosted, D1 on Cloudflare. One table, `prompt_rules`, with each
 * rule's owner as a key column beside its fields; every check is `createPromptRules`'s.
 */
import type { OwnerRef, PromptRule, PromptRules } from "@kantel/contracts";
import { type SqlDialect, type SqlDriver, type SqlRow, sqlNumber } from "@kantel/sql";
import { createPromptRules, organisationOf, ownerKey, type PromptRuleStore, type PromptRulesOptions } from "./index.ts";

/** The table and its index, for `migrateRules` or a target's own migrations. Every statement is idempotent. */
export function rulesSchema(dialect: SqlDialect): readonly string[] {
	const time = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS prompt_rules (
			id TEXT PRIMARY KEY,
			owner_key TEXT NOT NULL,
			organisation_id TEXT NOT NULL,
			owner TEXT NOT NULL,
			name TEXT NOT NULL,
			text TEXT NOT NULL,
			rule_order INTEGER NOT NULL,
			created_at ${time} NOT NULL,
			updated_at ${time} NOT NULL,
			UNIQUE (owner_key, name)
		)`,
		"CREATE INDEX IF NOT EXISTS prompt_rules_by_organisation ON prompt_rules (organisation_id)",
	];
}

export async function migrateRules(driver: SqlDriver): Promise<void> {
	await driver.batch(rulesSchema(driver.dialect).map((text) => ({ sql: text })));
}

interface RuleRow extends SqlRow {
	readonly id: unknown;
	readonly owner: unknown;
	readonly name: unknown;
	readonly text: unknown;
	readonly rule_order: unknown;
	readonly created_at: unknown;
	readonly updated_at: unknown;
}

const COLUMNS = "id, owner, name, text, rule_order, created_at, updated_at";

function ruleOf(row: RuleRow): PromptRule {
	return {
		id: String(row.id),
		owner: JSON.parse(String(row.owner)) as OwnerRef,
		name: String(row.name),
		text: String(row.text),
		order: sqlNumber(row.rule_order),
		createdAt: sqlNumber(row.created_at),
		updatedAt: sqlNumber(row.updated_at),
	};
}

export function createSqlPromptRuleStore(driver: SqlDriver): PromptRuleStore {
	return {
		async get(id) {
			const [row] = await driver.query<RuleRow>(`SELECT ${COLUMNS} FROM prompt_rules WHERE id = ?`, [id]);
			return row === undefined ? undefined : ruleOf(row);
		},
		async ofOwner(owner) {
			const rows = await driver.query<RuleRow>(`SELECT ${COLUMNS} FROM prompt_rules WHERE owner_key = ?`, [
				ownerKey(owner),
			]);
			return rows.map(ruleOf);
		},
		async save(rule) {
			const key = ownerKey(rule.owner);
			// One statement, so two racing writes of one name leave one rule with the first one's ID.
			await driver.query(
				`INSERT INTO prompt_rules (id, owner_key, organisation_id, owner, name, text, rule_order, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (owner_key, name) DO UPDATE SET
					text = excluded.text, rule_order = excluded.rule_order, updated_at = excluded.updated_at`,
				[
					rule.id,
					key,
					organisationOf(rule.owner),
					JSON.stringify(rule.owner),
					rule.name,
					rule.text,
					rule.order,
					rule.createdAt,
					rule.updatedAt,
				],
			);
			const [row] = await driver.query<RuleRow>(
				`SELECT ${COLUMNS} FROM prompt_rules WHERE owner_key = ? AND name = ?`,
				[key, rule.name],
			);
			if (row === undefined) throw new Error("A saved prompt rule is missing");
			return ruleOf(row);
		},
		async delete(id) {
			await driver.query("DELETE FROM prompt_rules WHERE id = ?", [id]);
		},
	};
}

export interface SqlPromptRulesOptions extends Omit<PromptRulesOptions, "store"> {
	readonly driver: SqlDriver;
}

/** `PromptRules` on SQL. Run `migrateRules` (or `rulesSchema` in the target's migrations) first. */
export function createSqlPromptRules(options: SqlPromptRulesOptions): PromptRules {
	const { driver, ...rest } = options;
	return createPromptRules({ ...rest, store: createSqlPromptRuleStore(driver) });
}
