import type { ToolItem } from "@harbour/protocol";
import { useEffect, useState } from "react";
import { StatusLabel } from "../primitives/status.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Section, Sheet } from "../workbench/specimen.tsx";
import { BrowserEntry } from "./browser-entry.tsx";
import { BrowserAddressBar, BrowserTabs, BrowserWindow, PlayerControls } from "./browser-window.tsx";
import { BrowsingGroup } from "./browsing-group.tsx";
import { EXAMPLE_SCREENSHOT } from "./fixture-screenshot.ts";
import { tool } from "./fixtures.ts";
import "./browser-live-view.css";

export default { title: "Session/Browser window" } satisfies StoryDefault;

const page = `data:image/png;base64,${EXAMPLE_SCREENSHOT}`;

const TABS = [
	{ id: "a", url: "https://www.kayak.co.uk/flights/LON-AMS/2026-11-12", title: "London to Amsterdam flights" },
	{ id: "b", url: "https://example.com/", title: "Example Domain" },
	{ id: "c", url: "https://www.skyscanner.net/transport/flights/lond/ams/" },
];

/** A replay's controls, playing on their own clock, as the view page's player does. */
function Player() {
	const duration = 78_000;
	const [position, setPosition] = useState(9_000);
	const [playing, setPlaying] = useState(false);
	const [speed, setSpeed] = useState(1);
	useEffect(() => {
		if (!playing) return;
		const timer = setInterval(() => setPosition((at) => Math.min(duration, at + 250 * speed)), 250);
		return () => clearInterval(timer);
	}, [playing, speed]);
	return (
		<PlayerControls
			playing={playing}
			position={position}
			duration={duration}
			onToggle={() => {
				if (position >= duration) setPosition(0);
				setPlaying((on) => !on);
			}}
			onSeek={setPosition}
			speed={speed}
			onSpeed={() => setSpeed((now) => (now === 4 ? 1 : now * 2))}
		/>
	);
}

function Tabs({ end }: { end?: boolean }) {
	const [active, setActive] = useState("a");
	return (
		<BrowserTabs
			label="The session's browsers"
			tabs={TABS}
			active={active}
			onSelect={setActive}
			{...(end
				? {
						end: (
							<>
								<StatusLabel status="idle">Replay</StatusLabel>
								<span className="hb-browser-live-note">Watch only</span>
							</>
						),
					}
				: {})}
		/>
	);
}

export const Window: Story = () => (
	<Sheet
		title="Browser window"
		intro="A browser's window around a view of it: tabs with each page's title or host, a read-only address bar, the page, and a replay's controls. Built from Harbour's own controls; it fetches nothing, not even favicons."
	>
		<Section title="Replay, several browsers">
			<Column>
				<div className="hb-browser-live">
					<BrowserWindow tabs={<Tabs end />} toolbar={<BrowserAddressBar url={TABS[0]?.url} />} footer={<Player />}>
						<div className="hb-browser-live-page">
							<img src={page} alt="The page" />
						</div>
					</BrowserWindow>
				</div>
			</Column>
		</Section>
		<Section title="Live, one browser">
			<Column>
				<div className="hb-browser-live">
					<BrowserWindow
						tabs={
							<BrowserTabs
								tabs={[{ id: "a", url: "https://example.com/", title: "Example Domain", busy: true }]}
								active="a"
								end={<StatusLabel status="working">Live</StatusLabel>}
							/>
						}
						toolbar={<BrowserAddressBar url="https://example.com/" />}
					>
						<div className="hb-browser-live-page">
							<img src={page} alt="The page" />
						</div>
					</BrowserWindow>
				</div>
			</Column>
		</Section>
		<Section title="Address bar">
			<Column>
				<BrowserAddressBar url="https://www.kayak.co.uk/flights/LON-AMS/2026-11-12?sort=bestflight_a&fs=stops=0" />
				<BrowserAddressBar url="http://localhost:8787/status" />
				<BrowserAddressBar url="about:blank" />
				<BrowserAddressBar placeholder="The address isn't known yet" />
			</Column>
		</Section>
		<Section title="Tabs with no title: the host, then New tab">
			<Column>
				<BrowserTabs
					tabs={[
						{ id: "a", url: "https://docs.example.org/guide/start" },
						{ id: "b", url: "about:blank" },
						{
							id: "c",
							title: "A very long page title that has to be cut short to fit in its tab",
							url: "https://x.com",
						},
					]}
					active="a"
				/>
			</Column>
		</Section>
	</Sheet>
);

const shot = { mimeType: "image/png", data: EXAMPLE_SCREENSHOT } as const;

const run = (browser: string, running = false): ToolItem[] => [
	{
		...tool(`${browser}-1`, "browser_open", "Opening example.com", {
			args: { url: "https://example.com" },
			output: "URL: https://example.com/\nTitle: Example Domain",
			seconds: 3.1,
		}),
		browserSessionId: browser,
		images: [shot],
	},
	{
		...tool(`${browser}-2`, "browser_act", "Reading the page", {
			args: { action: "look" },
			output: "URL: https://example.com/\nTitle: Example Domain",
			...(running ? { status: "running" as const } : { seconds: 0.8 }),
		}),
		browserSessionId: browser,
	},
];

export const Timeline: Story = () => (
	<Sheet
		title="Browsers in the timeline"
		intro="Each browsing run in the session's timeline carries its browser as a card: the page it was on, the last screenshot as a thumbnail, whether it is live or has a replay, and a click that shows it in the panel."
	>
		<Section title="Live, while the agent browses">
			<Column>
				<BrowsingGroup items={run("bs-live", true)} active onShowBrowser={() => {}} browserState="live" />
			</Column>
		</Section>
		<Section title="Closed, with a replay">
			<Column>
				<BrowsingGroup items={run("bs-replay")} onShowBrowser={() => {}} browserState="replay" />
			</Column>
		</Section>
		<Section title="Showing in the panel">
			<Column>
				<BrowsingGroup items={run("bs-shown")} onShowBrowser={() => {}} shownBrowser="bs-shown" browserState="live" />
			</Column>
		</Section>
		<Section title="No screenshot yet, state not known">
			<Column>
				<BrowserEntry
					page={{ url: "https://www.kayak.co.uk/flights/LON-AMS/2026-11-12" }}
					state="unknown"
					onShow={() => {}}
				/>
			</Column>
		</Section>
	</Sheet>
);

export const Mobile: Story = () => (
	<Sheet title="Browser window at 420px" intro="Tabs scroll sideways; the address is cut short with an ellipsis.">
		<Column>
			<div className="hb-browser-live">
				<BrowserWindow tabs={<Tabs end />} toolbar={<BrowserAddressBar url={TABS[0]?.url} />} footer={<Player />}>
					<div className="hb-browser-live-page">
						<img src={page} alt="The page" />
					</div>
				</BrowserWindow>
			</div>
		</Column>
	</Sheet>
);
Mobile.meta = { width: 420 };
