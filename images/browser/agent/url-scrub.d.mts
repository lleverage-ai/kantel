// Copied from tvdavies/brwsr@0d22bf8 (container/agent/url-scrub.d.mts) for Kantel's browser runtime
// (packages/browser/CONTRACT.md). Kantel changes: none.
// Types for url-scrub.mjs, which the Worker imports as well as the agent.
export declare const REDACTED: string;
export declare function sensitiveName(name: string): boolean;
export declare function scrubUrl<T>(url: T): T;
export declare function scrubUrlFields<T>(node: T): T;
