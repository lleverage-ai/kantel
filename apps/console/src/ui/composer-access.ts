import type { ComposerProps } from "@kantel/ui";

/**
 * What the composer says about access, for every session's composer: what Kantel's runtime does today, not a choice
 * it offers yet. Attachments are the host's (`app/attachments.ts`): a client that can upload takes files.
 *
 *
 * - Access: the runtime runs an agent's commands and file changes in its workspace without asking. A browser and the
 *   vault's secrets ask (approval cards); a connection asks only where its rules say Ask, so the description says that
 *   rather than that connections ask (#463). So "Full access" is the one level there is, and
 *   "Supervised" (ask before commands and file changes, T3 Code's approval-required mode) is listed, disabled, until
 *   the runtime can ask for a tool call.
 */
export const COMPOSER_ACCESS = {
	accessOptions: [
		{
			id: "full-access",
			label: "Full access",
			description:
				"Runs commands and edits files in its workspace without asking. Browsers and secrets still ask, and each connection follows its own rules.",
		},
		{
			id: "supervised",
			label: "Supervised",
			description: "Asks before commands and file changes.",
			disabledReason: "Not available yet. Would ask before commands and file changes.",
		},
	],
	access: "full-access",
} as const satisfies Pick<ComposerProps, "accessOptions" | "access">;
