/**
 * `OnboardingService` on SQL (`@harbour/sql`): Postgres self-hosted, D1 on Cloudflare. One table, `onboarding`, with a
 * row per organisation that has changed anything; its status, current step and steps are one JSON column. Every check
 * is `createOnboarding`'s.
 */
import {
	freshOnboarding,
	isOnboardingStep,
	type Onboarding,
	type OnboardingService,
	type OnboardingStatus,
	type OnboardingStepId,
	type OnboardingStepStatus,
} from "@harbour/contracts";
import { type SqlDialect, type SqlDriver, type SqlRow, sqlNumber } from "@harbour/sql";
import { createOnboarding, type OnboardingOptions, type OnboardingStore } from "./index.ts";

/** The table, for `migrateOnboarding` or a target's own migrations. Every statement is idempotent. */
export function onboardingSchema(dialect: SqlDialect): readonly string[] {
	const time = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS onboarding (
			organisation_id TEXT PRIMARY KEY,
			state TEXT NOT NULL,
			updated_at ${time} NOT NULL
		)`,
	];
}

export async function migrateOnboarding(driver: SqlDriver): Promise<void> {
	await driver.batch(onboardingSchema(driver.dialect).map((text) => ({ sql: text })));
}

interface OnboardingRow extends SqlRow {
	readonly organisation_id: unknown;
	readonly state: unknown;
	readonly updated_at: unknown;
}

/** What the `state` column holds. */
type State = Pick<Onboarding, "status" | "current" | "steps">;

const STEP_STATUSES: readonly unknown[] = ["pending", "done", "skipped"];
const STATUSES: readonly unknown[] = ["active", "completed", "dismissed"];

function onboardingOf(row: OnboardingRow): Onboarding {
	const organisationId = String(row.organisation_id);
	const fresh = freshOnboarding(organisationId);
	const state = JSON.parse(String(row.state)) as { readonly [key: string]: unknown };
	const stored = (typeof state.steps === "object" && state.steps !== null ? state.steps : {}) as {
		readonly [key: string]: unknown;
	};
	// A step the row doesn't name (one added since it was stored) reads as a fresh one does: pending.
	const stepOf = (step: OnboardingStepId): OnboardingStepStatus =>
		STEP_STATUSES.includes(stored[step]) ? (stored[step] as OnboardingStepStatus) : fresh.steps[step];
	return {
		organisationId,
		status: STATUSES.includes(state.status) ? (state.status as OnboardingStatus) : fresh.status,
		current: isOnboardingStep(state.current) ? state.current : fresh.current,
		steps: { models: stepOf("models"), connectors: stepOf("connectors"), session: stepOf("session") },
		updatedAt: sqlNumber(row.updated_at),
	};
}

export function createSqlOnboardingStore(driver: SqlDriver): OnboardingStore {
	return {
		async get(organisationId) {
			const [row] = await driver.query<OnboardingRow>(
				"SELECT organisation_id, state, updated_at FROM onboarding WHERE organisation_id = ?",
				[organisationId],
			);
			return row === undefined ? undefined : onboardingOf(row);
		},
		async save(onboarding) {
			const state: State = { status: onboarding.status, current: onboarding.current, steps: onboarding.steps };
			await driver.query(
				`INSERT INTO onboarding (organisation_id, state, updated_at) VALUES (?, ?, ?)
				ON CONFLICT (organisation_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
				[onboarding.organisationId, JSON.stringify(state), onboarding.updatedAt ?? 0],
			);
		},
	};
}

export interface SqlOnboardingOptions extends Omit<OnboardingOptions, "store"> {
	readonly driver: SqlDriver;
}

/** `OnboardingService` on SQL. Run `migrateOnboarding` (or `onboardingSchema` in the target's migrations) first. */
export function createSqlOnboarding(options: SqlOnboardingOptions): OnboardingService {
	const { driver, ...rest } = options;
	return createOnboarding({ ...rest, store: createSqlOnboardingStore(driver) });
}
