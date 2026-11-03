/**
 * The desktop's page (`openDesktop`'s `url` and `embedUrl`): noVNC's RFB client on the sandbox's VNC, through the
 * tunnel URL with the same ticket. The page's own URL carries the ticket, so whoever holds it can watch (and, unless
 * view-only, drive) the desktop until it expires, as the contract says. View-only is the client's setting: the
 * tunnel itself doesn't filter input yet.
 *
 * noVNC (MPL 2.0) loads from jsDelivr at a pinned version, so the page needs the viewer's browser to reach it.
 */
export const HOSTS_VIEW_PATH = "/v1/hosts/view";
export const NOVNC_VERSION = "1.7.0";
const NOVNC = `https://cdn.jsdelivr.net/npm/@novnc/novnc@${NOVNC_VERSION}/core/rfb.js`;

/** The page's Content-Security-Policy: noVNC from jsDelivr, the tunnel on this origin, nothing else. */
export const VIEWER_CSP = [
	"default-src 'none'",
	`script-src 'unsafe-inline' https://cdn.jsdelivr.net`,
	"style-src 'unsafe-inline'",
	"connect-src 'self' ws: wss:",
	"img-src data: blob:",
	"frame-ancestors *",
].join("; ");

export function desktopViewerHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sandbox desktop</title>
<style>
html, body { margin: 0; height: 100%; background: #111; color: #ddd; font: 14px system-ui, sans-serif; }
#screen { position: absolute; inset: 0; }
#status { position: absolute; left: 12px; bottom: 12px; padding: 4px 8px; background: rgba(0, 0, 0, 0.6); border-radius: 4px; }
#status:empty { display: none; }
</style>
</head>
<body>
<div id="screen"></div>
<div id="status">Connecting</div>
<script type="module">
import RFB from "${NOVNC}";
const status = document.getElementById("status");
const params = new URLSearchParams(location.search);
const url = new URL(location.href);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
url.pathname = url.pathname.replace("${HOSTS_VIEW_PATH}/", "/v1/hosts/tunnel/");
url.search = "";
const rfb = new RFB(document.getElementById("screen"), url.href);
rfb.scaleViewport = true;
rfb.resizeSession = false;
rfb.viewOnly = params.get("viewOnly") === "1";
rfb.addEventListener("connect", () => { status.textContent = ""; });
rfb.addEventListener("disconnect", (event) => {
	status.textContent = event.detail.clean ? "Disconnected" : "The desktop isn't reachable: the link may have expired";
});
</script>
</body>
</html>
`;
}
