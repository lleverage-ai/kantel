// Types for the parts of reflex.mjs (brwsr's Reflex bundle) that Kantel's tests call. Kantel's own file: brwsr's
// bundle ships no types.

/** The CDP connection Reflex drives: one `send` for the browser and, with `sessionId`, an attached page. */
export interface ReflexCdp {
	send(method: string, params?: unknown, sessionId?: string): Promise<any>;
}

export interface ReflexElement {
	readonly id: string;
	readonly describe: string;
}

export interface ReflexPage {
	readonly url: string;
	readonly title: string;
	readonly headings: readonly string[];
	readonly messages: readonly string[];
	readonly text: string;
	readonly elements: readonly ReflexElement[];
	/** The page didn't answer in time: the URL and title are the browser's, the rest the last look's (or nothing). */
	readonly busy?: true;
	/** The label of the cookie or consent button the browser clicked to decline a dialog first, if it did. */
	readonly declined?: string;
}

export interface ReflexActRequest {
	readonly pageId?: string;
	readonly verb?: string;
	readonly element?: string;
	readonly value?: string;
	readonly key?: string;
	readonly url?: string;
	readonly instruction?: string;
	/** `reject`: decline a cookie or consent dialog first, if one shows. */
	readonly consent?: "reject";
}

export declare class ReflexError extends Error {
	readonly status: number;
	constructor(status: number, message: string);
}

export declare function reflexAct(
	cdp: ReflexCdp,
	req: ReflexActRequest,
): Promise<{ readonly pageId: string; readonly success: boolean; readonly did?: string; readonly page: ReflexPage }>;

export declare function reflexLook(
	cdp: ReflexCdp,
	req: { readonly pageId?: string; readonly consent?: "reject" },
): Promise<ReflexPage & { readonly pageId: string; readonly steps: number }>;
