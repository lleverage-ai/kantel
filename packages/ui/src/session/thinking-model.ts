// Thinking levels: what the composer's thinking picker offers for a model, and what it shows as chosen. Pure, so the
// rules are tested without a browser. The levels are pi's (`ModelThinking` in @harbour/contracts), in order.

import type { ModelThinking } from "@harbour/contracts";

/** A thinking level, as pi and Harbour's model gateway name them, from none to the most. */
export type ThinkingLevel = ModelThinking;

/** Every level, from none to the most. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** What a person reads for each level, in the picker's rows and on its button: T3 Code's names for pi's levels. */
export const THINKING_LABELS: { readonly [level in ThinkingLevel]: string } = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * The levels to offer, in order, from what a model says it supports: unknown values dropped, duplicates removed. A
 * model that supports only `off`, or nothing, can't think: the picker hides for it.
 */
export function offeredLevels(levels: readonly string[] | undefined): ThinkingLevel[] {
	if (levels === undefined) return [];
	const offered = THINKING_LEVELS.filter((level) => levels.includes(level));
	return offered.some((level) => level !== "off") ? offered : [];
}

/**
 * The level a model runs with when `level` is asked for: `level` when the model supports it, else the nearest one above
 * it, else the nearest below, as pi's `clampThinkingLevel` does. Undefined when the model can't think.
 */
export function clampThinking(
	levels: readonly ThinkingLevel[],
	level: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
	if (levels.length === 0) return undefined;
	if (level === undefined) return levels[0];
	if (levels.includes(level)) return level;
	const asked = THINKING_LEVELS.indexOf(level);
	for (let index = asked + 1; index < THINKING_LEVELS.length; index += 1) {
		const candidate = THINKING_LEVELS[index];
		if (candidate !== undefined && levels.includes(candidate)) return candidate;
	}
	for (let index = asked - 1; index >= 0; index -= 1) {
		const candidate = THINKING_LEVELS[index];
		if (candidate !== undefined && levels.includes(candidate)) return candidate;
	}
	return levels[0];
}

/**
 * The level a picker over `levels` shows as chosen: `value`, else `fallback` (the session's default), clamped to what
 * the model supports; with neither, the model's lowest level.
 */
export function chosenThinking(
	levels: readonly ThinkingLevel[],
	value: ThinkingLevel | undefined,
	fallback?: ThinkingLevel,
): ThinkingLevel | undefined {
	return clampThinking(levels, value ?? fallback);
}

/** The next level up (`step` 1) or down (-1) from `current`, wrapping, as T3 Code's effort shortcut cycles. */
export function stepThinking(
	levels: readonly ThinkingLevel[],
	current: ThinkingLevel | undefined,
	step: 1 | -1,
): ThinkingLevel | undefined {
	if (levels.length === 0) return undefined;
	const index = current === undefined ? -1 : levels.indexOf(current);
	if (index === -1) return step > 0 ? levels[0] : levels.at(-1);
	return levels[(index + step + levels.length) % levels.length];
}
