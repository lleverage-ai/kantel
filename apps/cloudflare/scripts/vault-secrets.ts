/**
 * Writes the vault's Worker secrets for `wrangler deploy --secrets-file`, from the repository secrets of the same names
 * (src/vault.ts says what each is for). Only those that are set are written, and wrangler's secrets file is additive:
 * a secret left out keeps the value it already has on the Worker, and none is ever deleted.
 *
 * Each value is checked before anything is deployed: the vault key must be 32 bytes of base64, and a component's
 * shared key and CPA's key at least 16 characters. A bad value fails the run rather than deploy a vault that cannot start. Nothing
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
 * Kept in step with `VaultVars` in src/vault.ts, CPA's key in src/models.ts (which the vault object keeps as an
 * item) and brwsr's key in src/browser.ts (which only the browser provider holds); test/vault.test.ts checks they agree.
 */
export const VAULT_SECRETS = [
	"KANTEL_VAULT_KEY",
	"KANTEL_VAULT_MODEL_GATEWAY_TOKEN",
	"KANTEL_VAULT_EGRESS_GATEWAY_TOKEN",
	"KANTEL_CPA_API_KEY",
	"KANTEL_BRWSR_API_KEY",
	// Kantel's own browsers (src/browser-object.ts): view links' signing key and the key profiles and recordings are
	// sealed with in R2. Each at least 32 characters.
	"KANTEL_BROWSER_VIEW_KEY",
	"KANTEL_BROWSER_SEAL_KEY",
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

/** A shared key: at least 16 characters, with no spaces. */
export function isStrongToken(value: string): boolean {
	return value.length >= 16 && !/\s/.test(value);
}

/** The vault secrets that are set, checked. Throws naming every bad one (never its value). */
export function vaultSecrets(env: Readonly<Record<string, string | undefined>>): Partial<Record<VaultSecret, string>> {
	const secrets: Partial<Record<VaultSecret, string>> = {};
	const invalid: string[] = [];
	for (const name of VAULT_SECRETS) {
		const value = (env[name] ?? "").trim();
		if (value === "") continue;
		// CPA's key is held to the components' rule too: a short key would slip past the model gateway's redaction and
		// could be guessed from its item's name (src/models.ts).
		const ok =
			name === "KANTEL_VAULT_KEY"
				? isVaultKey(value)
				: name === "KANTEL_BROWSER_VIEW_KEY" || name === "KANTEL_BROWSER_SEAL_KEY"
					? isStrongToken(value) && value.length >= 32
					: isStrongToken(value);
		if (!ok) {
			invalid.push(
				name === "KANTEL_VAULT_KEY"
					? `${name} must be 32 random bytes in base64 (openssl rand -base64 32)`
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
