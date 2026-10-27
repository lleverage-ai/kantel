// The page the scripted task researches: an upstream outside the sandbox
// network that only answers when the vault injected the right credential.
// It never echoes request headers, so a leak would have to come from Harbour.

const secret = process.env.HARBOUR_CANARY_SECRET;
if (!secret) throw new Error("missing HARBOUR_CANARY_SECRET");
let served = 0;
let refused = 0;

const page = `<!doctype html>
<html><head><title>Harbour research fixture</title></head>
<body>
<h1>Tides of the Harbour</h1>
<p>Fetched through the Harbour vault with an injected credential the sandbox never saw.</p>
</body></html>
`;

Bun.serve({
	port: Number(process.env.PORT ?? 80),
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/_stats") return Response.json({ served, refused });
		if (request.headers.get("authorization") !== `Bearer ${secret}`) {
			refused++;
			return new Response("missing or wrong credential\n", { status: 401 });
		}
		served++;
		return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
	},
});
console.log("research fixture listening");
