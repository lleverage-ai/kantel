// Asks the vault proxy for https://<host><path> as an isolate-tier session would: CONNECT with the isolate key and a
// session, then GET inside the TLS the proxy intercepts. Prints the status and the start of the body. Run inside the
// vault-proxy container (CI's "The proxy fails closed without the vault"):
//
//   node connect-probe.mjs research-site / [session]
import http from "node:http";
import tls from "node:tls";

const [host, path = "/", session = "connect-probe"] = process.argv.slice(2);
if (!host) throw new Error("usage: connect-probe.mjs <host> [path] [session]");
const headers = { "x-kantel-host-key": process.env.VAULT_ISOLATE_KEY ?? "", "x-kantel-session": session };
const timer = setTimeout(() => {
	console.log("timeout");
	process.exit(2);
}, 20_000);

const request = http.request({ host: "127.0.0.1", port: 3128, method: "CONNECT", path: `${host}:443`, headers });
request.on("error", (error) => {
	console.log(`error ${error.message}`);
	process.exit(2);
});
request.on("connect", (response, socket) => {
	if (response.statusCode !== 200) {
		console.log(`CONNECT ${response.statusCode}`);
		process.exit(1);
	}
	// The proxy's CA is not this process's: what's checked here is the proxy's answer, not its certificate.
	const secure = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
		secure.write(`GET ${path} HTTP/1.1\r\nhost: ${host}\r\nconnection: close\r\n\r\n`);
	});
	let raw = "";
	secure.on("data", (chunk) => {
		raw += chunk;
	});
	secure.on("end", () => {
		clearTimeout(timer);
		const [head = "", ...rest] = raw.split("\r\n\r\n");
		const status = head.split(" ")[1] ?? "?";
		console.log(`${status} ${rest.join("\r\n\r\n").replace(/\s+/g, " ").trim().slice(0, 300)}`);
	});
});
request.end();
