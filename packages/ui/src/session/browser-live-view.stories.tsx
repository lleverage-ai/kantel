import type { ToolItem } from "@harbour/protocol";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Section, Sheet } from "../workbench/specimen.tsx";
import { BrowserLiveView } from "./browser-live-view.tsx";
import { EXAMPLE_SCREENSHOT } from "./fixture-screenshot.ts";
import { tool } from "./fixtures.ts";
import { ToolCallGroup } from "./tool-call.tsx";

export default { title: "Session/Browser live view" } satisfies StoryDefault;

const shot = { mimeType: "image/png", data: EXAMPLE_SCREENSHOT } as const;

// The live page, as a story can show it without brwsr: the browser's last frame, inline. In the console it is a
// watch-only brwsr share link.
const LIVE_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
	`<body style="margin:0"><img alt="" style="display:block;width:100%" src="data:image/png;base64,${EXAMPLE_SCREENSHOT}"></body>`,
)}`;

const opened: ToolItem = {
	...tool("v1", "browser_open", "Opening example.com", {
		args: { url: "https://example.com" },
		output: "URL: https://example.com/\nTitle: Example Domain",
		seconds: 3.1,
	}),
	images: [shot],
	browserSessionId: "bs_example",
};

const looked: ToolItem = {
	...tool("v2", "browser_act", "Reading the page", {
		args: { action: "look" },
		output: "URL: https://example.com/\nTitle: Example Domain",
		seconds: 0.8,
	}),
	browserSessionId: "bs_example",
};

const requested = tool("v0", "browser_request", "Asking for a browser", {
	args: { reason: "Look up what example.com says", sites: ["example.com"] },
	output: "Granted: a browser for example.com.",
	seconds: 9,
});

export const States: Story = () => (
	<Sheet
		title="Browser live view"
		intro="The browser the agent is using, live and watch-only, under the newest call on it. Before it connects and after the browser closes, the last screenshot takes its place."
	>
		<Section title="Live">
			<Column>
				<BrowserLiveView status="live" item={looked} url={LIVE_PAGE} screenshot={shot} />
			</Column>
		</Section>
		<Section title="Connecting">
			<Column>
				<BrowserLiveView status="connecting" item={looked} screenshot={shot} />
			</Column>
		</Section>
		<Section title="Connecting, before any screenshot">
			<Column>
				<BrowserLiveView status="connecting" item={looked} />
			</Column>
		</Section>
		<Section title="Browser closed">
			<Column>
				<BrowserLiveView status="ended" item={looked} screenshot={shot} />
			</Column>
		</Section>
		<Section title="Browser closed, with no screenshot">
			<Column>
				<BrowserLiveView status="ended" item={looked} />
			</Column>
		</Section>
		<Section title="Unavailable: the screenshot, as without a live view">
			<Column>
				<BrowserLiveView status="unavailable" item={looked} screenshot={shot} />
			</Column>
		</Section>
	</Sheet>
);

const view = (status: "live" | "ended") => (
	<BrowserLiveView status={status} item={looked} screenshot={shot} {...(status === "live" ? { url: LIVE_PAGE } : {})} />
);

export const InTheTranscript: Story = () => (
	<Sheet
		title="Live view in a tool group"
		intro="The view sits under the newest call on the browser, in place of its screenshots. A folded group keeps it in view under its summary."
	>
		<Section title="Working">
			<Column>
				<ToolCallGroup items={[requested, opened, looked]} live browserViews={new Map([["v2", view("live")]])} />
			</Column>
		</Section>
		<Section title="Folded, browser still open">
			<Column>
				<ToolCallGroup items={[requested, opened, looked]} browserViews={new Map([["v2", view("live")]])} />
			</Column>
		</Section>
		<Section title="Folded, browser closed">
			<Column>
				<ToolCallGroup items={[requested, opened, looked]} browserViews={new Map([["v2", view("ended")]])} />
			</Column>
		</Section>
	</Sheet>
);

export const Mobile: Story = () => (
	<Sheet title="Browser live view at 420px" intro="The frame keeps the browser's shape at the column's width.">
		<Column>
			<ToolCallGroup items={[requested, opened, looked]} live browserViews={new Map([["v2", view("live")]])} />
			<BrowserLiveView status="connecting" item={looked} screenshot={shot} />
			<BrowserLiveView status="ended" item={looked} screenshot={shot} />
		</Column>
	</Sheet>
);
Mobile.meta = { width: 420 };
