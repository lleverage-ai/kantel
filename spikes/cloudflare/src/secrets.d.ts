// Worker secrets, set with `wrangler secret put` (see README.md). Not in wrangler.jsonc, so `wrangler types` omits them.
interface __BaseEnv_Env {
	/** Bearer token every route except /health requires. */
	HARBOUR_SPIKE_TOKEN: string;
	/** The stub vault's one item: a canary value that must never reach a sandbox, transcript or log. */
	VAULT_CANARY: string;
}
