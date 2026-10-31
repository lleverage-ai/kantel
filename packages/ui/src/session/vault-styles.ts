// The vault's shared Tailwind classes (src/tokens/tailwind.css, docs/tailwind.md), for the pieces both the approval
// card (vault-approval-card.tsx) and the vault page (vault/vault-page.tsx) draw, so the binding code looks the same in
// both places. Each keeps its kt- class as a hook: vault-approval-card.css wraps the code row on a narrow screen, and
// apps/console/scripts/vault-api-check.ts waits for anything named like a skeleton to go.

/** Quiet words beside a value, such as "and below" after a path. */
export const vaultMuted = "kt-vault-muted text-muted";
/** An approved outcome's icon. */
export const vaultToneDone = "kt-vault-tone-done text-status-done";
/** A denied outcome's icon. */
export const vaultToneError = "kt-vault-tone-error text-status-error";
/** An expired, withdrawn or stopped outcome's icon. */
export const vaultToneFaint = "kt-vault-tone-faint text-faint";

/** The binding code's block: a sunken box with its label, its rule and the code, the one thing to compare. */
export const vaultCode = "kt-vault-code flex min-w-0 flex-col gap-1 rounded-control border border-border bg-sunken p-3";
/** The block's label, "Binding code". */
export const vaultCodeLabel = "kt-vault-code-label m-0 text-xs font-medium text-muted";
/** The block's one line saying where the same code shows. */
export const vaultCodeRule = "kt-vault-code-rule m-0 text-xs text-faint";
/** The code, with a copy button beside it on the card; wraps under 480px (vault-approval-card.css). */
export const vaultCodeRow = "kt-vault-code-row mt-1.5 flex min-w-0 items-center gap-2";
/** The code itself: large mono, tabular figures. */
export const vaultCodeValue =
	"kt-vault-code-value min-w-0 font-mono text-display font-medium leading-tight text-fg tabular-nums wrap-anywhere";
/**
 * The code block's placeholder while loading. Its height is `--kt-vault-code-height`, which only the card sets (the
 * block's own height); outside a card the variable is unset and the placeholder has no height, as it had before.
 */
export const vaultSkeletonCode = "kt-vault-skeleton-code block h-(--kt-vault-code-height) rounded-control bg-sunken";
