/**
 * Writes the vault's Worker secrets for `wrangler deploy --secrets-file`, from the repository secrets of the same names
 * (src/vault.ts says what each is for). Only those that are set are written, and wrangler's secrets file is additive:
 * a secret left out keeps the value it already has on the Worker, and none is ever deleted.
 *
 * Each value is checked before anything is deployed: the vault key must be 32 bytes of base64, and a component's
 * shared key at least 16 characters. A bad value fails the run rather than deploy a vault that cannot start. Nothing
 * here prints a value.
 *
 * Usage: node scripts/vault-secrets.ts --out <file>. Prints the names it wrote; writes `file=<path>` to
 * `$GITHUB_OUTPUT` when it wrote any.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/**
 * Kept in step with `VaultVars` in src/vault.ts and CPA's key in src/models.ts (which the vault object keeps as an
 * item); test/vault.test.ts checks they agree.
 */
export const VAULT_SECRETS = [
	"HARBOUR_VAULT_KEY",
	"HARBOUR_VAULT_MODEL_GATEWAY_TOKEN",
	"HARBOUR_VAULT_EGRESS_GATEWAY_TOKEN",
	"HARBOUR_CPA_API_KEY",
] as const;

export type VaultSecret = (typeof VAULT_SECRETS)[number];

function isVaultKey(value: string): boolean {
	if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
	try {
		return atob(value.replace(/-/g, "+").replace(/_/g, "/")).length === 32;
	} catch {
		return false;
	}
}

/** The vault secrets that are set, checked. Throws naming every bad one (never its value). */
export function vaultSecrets(env: Readonly<Record<string, string | undefined>>): Partial<Record<VaultSecret, string>> {
	const secrets: Partial<Record<VaultSecret, string>> = {};
	const invalid: string[] = [];
	for (const name of VAULT_SECRETS) {
		const value = (env[name] ?? "").trim();
		if (value === "") continue;
		// CPA's key is whatever CPA was given; it only has to fit in a header.
		const ok =
			name === "HARBOUR_VAULT_KEY"
				? isVaultKey(value)
				: name === "HARBOUR_CPA_API_KEY"
					? !/\s/.test(value)
					: value.length >= 16 && !/\s/.test(value);
		if (!ok) {
			invalid.push(
				name === "HARBOUR_VAULT_KEY"
					? `${name} must be 32 random bytes in base64 (openssl rand -base64 32)`
					: name === "HARBOUR_CPA_API_KEY"
						? `${name} must have no spaces`
						: `${name} must be at least 16 characters with no spaces`,
			);
			continue;
		}
		secrets[name] = value;
	}
	if (invalid.length > 0) throw new Error(invalid.join("; "));
	return secrets;
}

function main(): void {
	const { values: args } = parseArgs({ options: { out: { type: "string" } } });
	if (args.out === undefined) throw new Error("Pass --out <file>");
	const secrets = vaultSecrets(process.env);
	const names = Object.keys(secrets);
	if (names.length === 0) {
		console.log("No vault secrets are set; the deploy leaves the Worker's as they are");
		return;
	}
	const out = resolve(args.out);
	writeFileSync(out, JSON.stringify(secrets), { mode: 0o600 });
	console.log(`Vault secrets to set: ${names.join(", ")}`);
	if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, `file=${out}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
