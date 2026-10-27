import type { ReactNode } from "react";

// Ladle's story shapes, declared here: @ladle/react ships its typings as .tsx sources that do not typecheck under
// this workspace's TypeScript, so stories import these instead of Ladle's own.

export type Story<P = Record<string, never>> = ((props: P) => ReactNode) & {
	meta?: { width?: number | string; [key: string]: unknown };
	storyName?: string;
};

export type StoryDefault = { title?: string; meta?: Record<string, unknown> };
