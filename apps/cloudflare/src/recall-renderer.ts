/**
 * Which `RecallRenderer` the stack's memory store renders recall with (#12). The store counts its recall budgets in
 * rendered bytes, so the renderer decides which concepts fit as well as how they read:
 *
 * - `default`: Kantel's own rendering (`defaultRecallRenderer`). The default.
 * - `sal`: a Sal worker's rendering (`salRecallRenderer`), for a deployment that serves Sal's memory, so a session
 *   recalls the concepts, and the text, a local Sal worker gets for the same brief. A Worker has no file system, so a
 *   concept's local sources count as missing, as a local Sal worker reports a path it no longer has.
 *
 * A deployment picks one with `KANTEL_RECALL_RENDERER`; code that builds the stack itself passes `recallRenderer`.
 * Either way Kantel adds no prompt text: the renderer only shapes the recall block the runtime already places.
 */
import { KantelError, type RecallRenderer } from "@kantel/contracts";
import { defaultRecallRenderer, salRecallRenderer } from "@kantel/memory";

export const RECALL_RENDERERS = ["default", "sal"] as const;
export type RecallRendererName = (typeof RECALL_RENDERERS)[number];

export interface RecallVars {
	readonly KANTEL_RECALL_RENDERER?: string;
}

const isRecallRenderer = (value: string): value is RecallRendererName =>
	(RECALL_RENDERERS as readonly string[]).includes(value);

/** The renderer the vars name; unset or empty is `default`, anything else unknown is refused. */
export function recallRendererFrom(vars: RecallVars): RecallRenderer {
	const value = (vars.KANTEL_RECALL_RENDERER ?? "").trim();
	if (value === "" || value === "default") return defaultRecallRenderer;
	if (!isRecallRenderer(value)) {
		throw new KantelError("invalid", `KANTEL_RECALL_RENDERER must be one of: ${RECALL_RENDERERS.join(", ")}`);
	}
	return salRecallRenderer();
}
