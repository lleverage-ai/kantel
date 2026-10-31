import type { TranscriptItem } from "@kantel/protocol";
import { EXAMPLE_SCREENSHOT } from "./fixture-screenshot.ts";

// A real browsing session for stories and tests: a person asked for the cheapest flights from Manchester to Amsterdam,
// and the agent tried Skyscanner (a bot check), Google Flights (a consent page it couldn't click through) and Kayak
// (a page that didn't answer in 60 s), in 15 browser calls, 4 of which failed. Its items as the session's API sent
// them (Kantel session e9a2de1d, 31 Oct 2026), with long page text cut short and each screenshot replaced by the
// example one.

const shot = { mimeType: "image/png", data: EXAMPLE_SCREENSHOT } as const;

export const BROWSING_SESSION: readonly TranscriptItem[] = [
	{
		kind: "user",
		id: "u7",
		at: 1793445250601,
		text: "Search for the cheapest flights from Manchester airport to Amsterdam, 16th to 19th December. No flights too early in the morning please.",
		via: "prompt",
		requestId: "c51e90d6-41d2-4513-b52a-a27717917f93",
	},
	{
		kind: "assistant",
		id: "a11",
		at: 1793445254635,
		text: "",
		streaming: false,
		thinking:
			"I need to find a way to search flights, but there's no direct flight search tool available—just browser and connections. Let me check the connections list to see if a flight search service is configured there.\n\n",
	},
	{
		kind: "tool",
		id: "t11:toolu_01DDXwaofnhAR47dAEWzhg15",
		at: 1793445254638,
		callId: "toolu_01DDXwaofnhAR47dAEWzhg15",
		name: "connections_list",
		label: "Calling connections_list",
		status: "done",
		args: {},
		output: '[\n  { "id": "conn_example", "name": "MCP example", "kind": "mcp", "owner": "user" }\n]',
		endedAt: 1793445254669,
	},
	{
		kind: "assistant",
		id: "a15",
		at: 1793445257410,
		text: "None of the connections I have are flight search services, so I'll try a browser and look at a flight search site directly.",
		streaming: false,
		thinking:
			"There's no direct flight search connection available, so I should request browser access to sites like Google Flights or Skyscanner instead.\n\n",
	},
	{
		kind: "tool",
		id: "t15:toolu_01KvWuFezgAiWQQkq8H3qd44",
		at: 1793445257424,
		callId: "toolu_01KvWuFezgAiWQQkq8H3qd44",
		name: "browser_request",
		label: "Asking for a browser",
		status: "done",
		args: {
			reason:
				"To search for cheap flights from Manchester (MAN) to Amsterdam (AMS) departing 16 December 2026 and returning 19 December 2026, and compare fares on a flight search site.",
			sites: ["www.google.com", "www.skyscanner.net", "www.kayak.co.uk"],
		},
		output:
			"A person allowed a browser for www.google.com, www.skyscanner.net, www.kayak.co.uk. browser_open works now.",
		endedAt: 1793445263396,
	},
	{
		kind: "assistant",
		id: "a19",
		at: 1793445266711,
		text: "",
		streaming: false,
		thinking:
			"Today's date is October 31, 2026, so the user's December 16th-19th trip must refer to this year. I'll check Skyscanner for flights departing the 16th and returning the 19th.\n\n",
	},
	{
		kind: "tool",
		id: "t19:toolu_011SfgMV5bbJqV2MHTnWSooD",
		at: 1793445266715,
		callId: "toolu_011SfgMV5bbJqV2MHTnWSooD",
		name: "browser_open",
		label: "Opening www.skyscanner.net",
		status: "done",
		args: {
			url: "https://www.skyscanner.net/transport/flights/man/ams/261216/261219/",
		},
		output:
			"Opened browser bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea until 2026-10-31T11:44:31.590Z, for www.google.com, www.skyscanner.net, www.kayak.co.uk.\n\nURL: https://www.skyscanner.net/sttc/px/captcha-v2/index.html?url=L3RyYW5zcG9ydC9mbGlnaHRzL21hbi9hbXMvMjYxMjE2LzI2MTIxOS8/&uuid=3f047af2-d51c-11f1-80c4-7c5a51131aea&vid=\nTitle: Skyscanner\nDid: goto https://www.skyscanner.net/transport/flights/man/ams/261216/261219/\n\nAre you a person or a robot? Please don’t take this personally - some scripts and bots are remarkably lifelike these days! Still having problems accessing the page? Try checking you have JavaScript and cookies turned on and that your browser isn’t blocking them from loading. 3f047a [cut]",
		browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		endedAt: 1793445277663,
		images: [shot],
	},
	{
		kind: "assistant",
		id: "a23",
		at: 1793445280584,
		text: "Skyscanner is showing a bot check. I'll try Google Flights instead.",
		streaming: false,
		thinking: "Skyscanner's blocked by a captcha, so I'll try Google Flights or Kayak instead.\n\n",
	},
	{
		kind: "tool",
		id: "t23:toolu_012ASwntEUBsqdREQTAwBWzM",
		at: 1793445280590,
		callId: "toolu_012ASwntEUBsqdREQTAwBWzM",
		name: "browser_act",
		label: "Going to www.google.com",
		status: "done",
		args: {
			browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
			action: "goto",
			url: "https://www.google.com/travel/flights?q=Flights%20from%20Manchester%20to%20Amsterdam%20on%202026-12-16%20returning%202026-12-19",
		},
		output:
			"URL: https://consent.google.com/m?continue=https://www.google.com/travel/flights?q%3DFlights%2Bfrom%2BManchester%2Bto%2BAmsterdam%2Bon%2B2026-12-16%2Breturning%2B2026-12-19&gl=NL&m=0&pc=flt&cm=2&hl=en-US&src=1\nTitle: Before you continue\nDid: goto https://www.google.com/travel/flights?q=Flights%20from%20Manchester%20to%20Amsterdam%20on%202026-12-16%20returning%202026-12-19\n\nEN Sign in Before you continue to Google We use cookies and data, including IP addresses, to Deliver and maintain Google services Track outages and protect against spam, fraud, and abuse Measure audience engagement and site statistics to understand how our services are used and enhance the quality of those services If you [cut]",
		browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		endedAt: 1793445282311,
		images: [shot],
	},
	{
		kind: "tool",
		id: "t23:toolu_01NNfsHQ8MBukALWRakVJayr",
		at: 1793445280590,
		callId: "toolu_01NNfsHQ8MBukALWRakVJayr",
		name: "browser_act",
		label: "Waiting for the page",
		status: "done",
		args: {
			browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
			action: "wait",
		},
		output:
			"URL: https://consent.google.com/m?continue=https://www.google.com/travel/flights?q%3DFlights%2Bfrom%2BManchester%2Bto%2BAmsterdam%2Bon%2B2026-12-16%2Breturning%2B2026-12-19&gl=NL&m=0&pc=flt&cm=2&hl=en-US&src=1\nTitle: Before you continue\nDid: wait\n\nEN Sign in Before you continue to Google We use cookies and data, including IP addresses, to Deliver and maintain Google services Track outages and protect against spam, fraud, and abuse Measure audience engagement and site statistics to understand how our services are used and enhance the quality of those services If you choose to “Accept all,” we will also use cookies and data, including IP addresses, to Develop and improve new services Deliver a [cut]",
		browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		endedAt: 1793445282987,
		images: [shot],
	},
	{
		kind: "tool",
		id: "ts1:toolu_017hfMbFVYSf5hyNZYFvx2zT",
		at: 1793445285087,
		callId: "toolu_017hfMbFVYSf5hyNZYFvx2zT",
		name: "browser_act",
		label: "Clicking on the page",
		status: "error",
		args: {
			browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
			action: "click",
			element: "[4]",
		},
		output:
			"browser.act failed (unavailable): The browser: No element [4] on https://consent.google.com/m?continue=https://www.google.com/travel/flights?q%3DFlights%2Bfrom%2BManchester%2Bto%2BAmsterdam%2Bon%2B2026-12-16%2Breturning%2B2026-12-19&gl=NL&m=0&pc=flt&cm=2&hl=en-US&src=1; look again",
		browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		endedAt: 1793445286123,
	},
	{
		kind: "tool",
		id: "ts2:toolu_01QpCWzofgN3Wwp3Ffrog7UE",
		at: 1793445287880,
		callId: "toolu_01QpCWzofgN3Wwp3Ffrog7UE",
		name: "browser_act",
		label: "Reading the page",
		status: "done",
		args: {
			browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
			action: "look",
		},
		output:
			"URL: https://consent.google.com/m?continue=https://www.google.com/travel/flights?q%3DFlights%2Bfrom%2BManchester%2Bto%2BAmsterdam%2Bon%2B2026-12-16%2Breturning%2B2026-12-19&gl=NL&m=0&pc=flt&cm=2&hl=en-US&src=1\nTitle: Before you continue\n\nEN Sign in Before you continue to Google We use cookies and data, including IP addresses, to Deliver and maintain Google services Track outages and protect against spam, fraud, and abuse Measure audience engagement and site statistics to understand how our services are used and enhance the quality of those services If you choose to “Accept all,” we will also use cookies and data, including IP addresses, to Develop and improve new services Deliver and measure [cut]",
		browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		endedAt: 1793445288205,
	},
	{
		kind: "tool",
		id: "ts3:toolu_01CCHJ6KqnAVFzVjjXYcoHD6",
		at: 1793445289777,
		callId: "toolu_01CCHJ6KqnAVFzVjjXYcoHD6",
		name: "browser_act",
		label: "Clicking on the page",
		status: "error",
		args: {
			browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
			action: "click",
			element: "[4]",
		},
		output:
			"browser.act failed (unavailable): The browser: No element [4] on https://consent.google.com/m?continue=https://www.google.com/travel/flights?q%3DFlights%2Bfrom%2BManchester%2Bto%2BAmsterdam%2Bon%2B2026-12-16%2Breturning%2B2026-12-19&gl=NL&m=0&pc=flt&cm=2&hl=en-US&src=1; look again",
		browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		endedAt: 1793445290029,
	},
	{
		kind: "assistant",
		id: "a41",
		at: 1793445294399,
		text: "",
		streaming: false,
		thinking:
			"The reject button click isn't working, so I'm considering trying \"Accept all\" instead since clicking through a routine cookie consent is a minor, low-stakes action for continuing the browse.\n\n",
	},
	{
		kind: "tool",
		id: "t41:toolu_01RnU23LG81adLbmQ7LsvPYP",
		at: 1793445294403,
		callId: "toolu_01RnU23LG81adLbmQ7LsvPYP",
		name: "browser_act",
		label: "Going to www.kayak.co.uk",
		status: "done",
		args: {
			browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
			action: "goto",
			url: "https://www.kayak.co.uk/flights/MAN-AMS/2026-12-16/2026-12-19?sort=price_a",
		},
		output:
			"URL: https://www.kayak.co.uk/flights/MAN-AMS/2026-12-16/2026-12-19?sort=price_a\nTitle: MAN to AMS, 16/12 – 19/12\nDid: goto https://www.kayak.co.uk/flights/MAN-AMS/2026-12-16/2026-12-19?sort=price_a\n\nEdit search form Go to flights filters Go to flights results section Ask AI GBP Loading results. Loading Track prices * Prices are per person and do not include baggage fees. Some train and bus prices may not include a service fee added by the provider at check-out. Company About Careers Mobile Blog How we work Contact Help/FAQ Press Affiliates Hotel owners Partners Advertise with us More Airline fees Airlines Low fare tips Badges & Certificates Security Get the KAYAK app ©2026 KAYAK Cookie setti [cut]",
		browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		endedAt: 1793445309302,
		images: [shot],
	},
	{
		kind: "tool",
		id: "ts4:toolu_01GEbYDAG2ZcDjDnMEnCKQjq",
		at: 1793445311005,
		callId: "toolu_01GEbYDAG2ZcDjDnMEnCKQjq",
		name: "browser_act",
		label: "Waiting for the page",
		status: "error",
		args: {
			browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
			action: "wait",
		},
		output:
			"browser.act failed (unavailable): The page did not answer within 60 s; it may still be loading. The browser is still open",
		browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		endedAt: 1793445371329,
	},
	{
		kind: "tool",
		id: "ts5:toolu_01L2U3BtnFBD9StLHjTEeDc6",
		at: 1793445372650,
		callId: "toolu_01L2U3BtnFBD9StLHjTEeDc6",
		name: "browser_act",
		label: "Reading the page",
		status: "done",
		args: {
			browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
			action: "look",
		},
		output:
			"URL: https://www.kayak.co.uk/flights/MAN-AMS/2026-12-16/2026-12-19?sort=price_a\nTitle: MAN to AMS, 16/12 – 19/12\n\nEdit search form Go to flights filters Go to flights results section Ask AI Return Manchester Amsterdam Wed 16/12 – Sat 19/12 1 Return Manchester Amsterdam Wed 16/12 Sat 19/12 1 GBP 75% complete. Loading Track prices Smart Filters . AI-powered; AI can make mistakes. Learn more Filter flights 677 of 1712 flights Stops Direct £112 1 stop £200 2+ stops Fare assistant Cabin bag Checked bag Times Take-off Landing Take-off from MAN Wed 05:30 22:30 Take-off from AMS Sat 02:00 23:00 Airlines Select all | Clear all Aer Lingus £329 British Airways £333 KLM £132 Lufthansa £285 Scandinavian [cut]",
		browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		endedAt: 1793445387579,
	},
	{
		kind: "assistant",
		id: "p1",
		at: 1793445393459,
		streaming: false,
		text: "The Kayak results are loading, and the cheapest options so far include some very early departures. I'll filter out the early times.",
		thinking:
			"The results are loading partially, sorted by cheapest price, with the top option at £112 for an outbound flight Wednesday 18:45–21:05 and return Saturday 10:45–11:10. I'm checking this against my time filter constraints for both legs.\n\nSince the user wants no early mornings, I'm thinking about setting the time filter to depart after 9am both ways. I'm also considering trying Kayak's \"Ask AI\" search box to describe the time constraint in natural language rather than manually adjusting filters.\n\n",
	},
	{
		kind: "tool",
		id: "t53:toolu_01P564Ws2R7Z54YLNGhHZ7xQ",
		at: 1793445393471,
		callId: "toolu_01P564Ws2R7Z54YLNGhHZ7xQ",
		name: "browser_act",
		label: "Typing into the page",
		status: "error",
		args: {
			browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
			action: "fill",
			element: "[49]",
			value: "only flights departing Manchester after 9am and returning from Amsterdam after 9am",
		},
		output:
			"browser.act failed (unavailable): The browser: No element [49] on https://www.kayak.co.uk/flights/MAN-AMS/2026-12-16/2026-12-19?sort=price_a; look again",
		browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		endedAt: 1793445393873,
	},
	{
		kind: "assistant",
		id: "a57",
		at: 1793445397007,
		text: "",
		streaming: false,
		thinking:
			"The element IDs keep shifting, so I need to track my steps carefully. There might be a cookie consent banner to dismiss first, so I'll check for that.\n\n",
	},
	{
		kind: "tool",
		id: "t57:toolu_01BPZHB3oKcpf8fDjoxA5hV4",
		at: 1793445397011,
		callId: "toolu_01BPZHB3oKcpf8fDjoxA5hV4",
		name: "browser_act",
		label: "Reading the page",
		status: "done",
		args: {
			browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
			action: "look",
		},
		output:
			"URL: https://www.kayak.co.uk/flights/MAN-AMS/2026-12-16/2026-12-19?sort=price_a\nTitle: MAN to AMS, 16/12 – 19/12\n\nEdit search form Go to flights filters Go to flights results section Ask AI Return Manchester Amsterdam Wed 16/12 – Sat 19/12 1 Return Manchester Amsterdam Wed 16/12 Sat 19/12 1 GBP 75% complete. Book now Prices are expected to rise £19 in the next 45 days Track prices Smart Filters . AI-powered; AI can make mistakes. Learn more Filter flights 677 of 1712 flights Stops Direct £112 1 stop £200 2+ stops Fare assistant Cabin bag Checked bag Times Take-off Landing Take-off from MAN Wed 05:30 22:30 Take-off from AMS Sat 02:00 23:00 Airlines Select all | Clear all Aer Lingus £329 Briti [cut]",
		browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		endedAt: 1793445397160,
	},
	{
		kind: "assistant",
		id: "p2",
		at: 1793445403859,
		streaming: false,
		text: "The results are loading and sorted by cheapest. I'll scroll to see more listings.",
		thinking:
			"I'm looking at the results page now, checking the cheapest options—there's a £112 direct return showing MAN–AMS and back, plus another option with different flight times to compare against it.\n\nBoth options look fine for timing, nothing too early for the user, though I should flag that this fare bundle likely excludes checked baggage. The results seem truncated, so I want to scroll down to see if there are more flight options before settling on a recommendation.\n\n",
	},
	{
		kind: "tool",
		id: "t61:toolu_01H8tYP9P62mZKhDhZKRmcDw",
		at: 1793445403864,
		callId: "toolu_01H8tYP9P62mZKhDhZKRmcDw",
		name: "browser_act",
		label: "Scrolling the page",
		status: "done",
		args: {
			browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
			action: "scroll",
		},
		output:
			"URL: https://www.kayak.co.uk/flights/MAN-AMS/2026-12-16/2026-12-19?sort=price_a\nTitle: MAN to AMS, 16/12 – 19/12\nDid: scroll\n\nEdit search form Go to flights filters Go to flights results section Ask AI Return Manchester Amsterdam Wed 16/12 – Sat 19/12 1 Return Manchester Amsterdam Wed 16/12 Sat 19/12 1 GBP 75% complete. Book now Prices are expected to rise £19 in the next 45 days Track prices Smart Filters . AI-powered; AI can make mistakes. Learn more Filter flights 677 of 1712 flights Stops Direct £112 1 stop £200 2+ stops Fare assistant Cabin bag Checked bag Times Take-off Landing Take-off from MAN Wed 05:30 22:30 Take-off from AMS Sat 02:00 23:00 Airlines Select all | Clear all Aer Lingu [cut]",
		browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		endedAt: 1793445404519,
		images: [shot],
	},
	{
		kind: "tool",
		id: "t61:toolu_01KYtBG6RVkTQxMtkqPAbUw1",
		at: 1793445403864,
		callId: "toolu_01KYtBG6RVkTQxMtkqPAbUw1",
		name: "browser_act",
		label: "Reading the page",
		status: "done",
		args: {
			browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
			action: "look",
		},
		output:
			"URL: https://www.kayak.co.uk/flights/MAN-AMS/2026-12-16/2026-12-19?sort=price_a\nTitle: MAN to AMS, 16/12 – 19/12\n\nEdit search form Go to flights filters Go to flights results section Ask AI Return Manchester Amsterdam Wed 16/12 – Sat 19/12 1 Return Manchester Amsterdam Wed 16/12 Sat 19/12 1 GBP 75% complete. Book now Prices are expected to rise £19 in the next 45 days Track prices Smart Filters . AI-powered; AI can make mistakes. Learn more Filter flights 677 of 1712 flights Stops Direct £112 1 stop £200 2+ stops Fare assistant Cabin bag Checked bag Times Take-off Landing Take-off from MAN Wed 05:30 22:30 Take-off from AMS Sat 02:00 23:00 Airlines Select all | Clear all Aer Lingus £329 Briti [cut]",
		browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		endedAt: 1793445404086,
	},
	{
		kind: "assistant",
		id: "p3",
		at: 1793445414012,
		streaming: false,
		text: "",
		thinking:
			"I'm scanning the results and the cheapest fares are around £112 for two different flight combos—one with an evening outbound and one with an afternoon outbound, both pairing with the same 10:45 return—followed by options at £113 and £116.\n\nThere's a time filter slider for MAN departures that I'd like to adjust to a 9am minimum, but it's not easily draggable through the tool, so I'll skip that and just work with the visible results. I'll report the two £112 options along with their dates and time…",
	},
	{
		kind: "tool",
		id: "t67:toolu_01HzBEpdfBQpEe45PggC7zxn",
		at: 1793445414017,
		callId: "toolu_01HzBEpdfBQpEe45PggC7zxn",
		name: "browser_close",
		label: "Closing the browser",
		status: "done",
		args: {
			browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		},
		output: "Closed browser bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea.",
		browserSessionId: "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea",
		endedAt: 1793445415417,
	},
	{
		kind: "assistant",
		id: "p4",
		at: 1793445430353,
		streaming: false,
		text: "I couldn't finish a clean search. I got partial results from Kayak, but I didn't get the morning-time filter applied, so I can't say for sure which is the cheapest acceptable flight.\n\n**What I saw** (Kayak, return trip, Manchester to Amsterdam Schiphol, Wed 16 Dec out, Sat 19 Dec back, prices per person, GBP, excluding bags):\n\n- **£112, direct:** out 18:45 to 21:05 on 16 Dec. The return I captured was 10:45 to 11:10 from Amsterdam on 19 Dec, though I'm not certain that pairing is right.\n- **£112, direct:** out 14:50 to 17:15 on 16 Dec, with a 10:45 return listed.\n- **£113 and £116:** I saw the prices but not the times or airlines.\n\nThe airline for the £112 fares wasn't captured. KLM's lowest fare was £132 on the same results, so the £112 is probably from another carrier.\n\n**Caveat on morning flights:** the results still included flights from Manchester as early as 05:30 and returns from Amsterdam as early as 02:00, so the list isn't filtered for your times yet. The two £112 options above both depart in the afternoon or evening, so they suit you.\n\n**To finish the search:** open the Kayak results, set the Manchester take-off slider to about 09:00 or later and the Amsterdam take-off slider to about 10:00 or later, then sort by cheapest:\nhttps://www.kayak.co.uk/flights/MAN-AMS/2026-12-16/2026-12-19?sort=price_a\n\nKayak also shows \"prices are expected to rise £19 in the next 45 days\", so booking sooner may help. Google Flights showed a cookie consent page I couldn't get past, and Skyscanner showed a bot check, so I couldn't use either. Prices change quickly, so check the final fare when you book.",
		thinking:
			"I'm only getting partial results so far — the cheapest option showing is £112 for a direct flight out Wed 18:45 and returning Sat 10:45, both MAN-AMS direct routes, which seems like a reasonable timing.\n\nThe two visible £112 fares are 18:45 out/10:45 back and 14:50 out/10:45 back, both direct, with £113 and £116 options unspecified — and since KLM's own minimum is £132, that £112 fare must be from a different, unlisted budget carrier. I still haven't applied the time filter, and the results were…",
	},
];
