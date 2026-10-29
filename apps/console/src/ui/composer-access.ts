import type { ComposerProps } from "@harbour/ui";

/**
 * What the composer says about access and attachments, for every session's composer: what Harbour's runtime does
 * today, not a choice it offers yet.
 *
 * - Access: the runtime runs an agent's commands and file changes in its workspace without asking; a browser and the
 *   vault's secrets are the only things it asks for (approval cards). So "Full access" is the one level there is, and
 *   "Supervised" (ask before commands and file changes, T3 Code's approval-required mode) is listed, disabled, until
 *   the runtime can ask for a tool call.
 * - Attachments: the composer can take files, but the runtime doesn't read a prompt's attachments yet
 *   (docs/contracts.md, open question 14), so the paperclip shows disabled, saying so.
 */
export const COMPOSER_ACCESS = {
	accessOptions: [
		{
			id: "full-access",
			label: "Full access",
			description: "Runs commands and edits files in its workspace without asking. Browsers and secrets still ask.",
		},
		{
			id: "supervised",
			label: "Supervised",
			description: "Asks before commands and file changes.",
			disabledReason: "Not available yet. Would ask before commands and file changes.",
		},
	],
	access: "full-access",
	attachUnavailable: "Attaching files isn't available yet",
} as const satisfies Pick<ComposerProps, "accessOptions" | "access" | "attachUnavailable">;
