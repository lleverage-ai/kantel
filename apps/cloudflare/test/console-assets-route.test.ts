// The console's files (src/route.ts `consoleAsset`): wrangler.jsonc sends every miss to the Worker. A file the build
// holds is served as it is; a page path gets the console's page, which routes in the browser; and a missing build file
// under /assets/ is a 404, so a tab opened before a deploy fails its dynamic import as a missing script instead of
// loading the page as one ("'text/html' is not a valid JavaScript MIME type").
import { describe, expect, it } from "vitest";
import { consoleAsset, routeRequest } from "../src/route.ts";

const BASE = "https://kantel.test";
const PAGE = "<!doctype html><title>Kantel</title>";

/** Static assets holding the console's page and one chunk, answering a miss with 404 as `not_found_handling: none` does. */
function assets() {
	const asked: string[] = [];
	const files: { readonly [path: string]: { readonly body: string; readonly type: string } } = {
		"/": { body: PAGE, type: "text/html" },
		"/assets/image-body-NEW.js": { body: "export default 1", type: "text/javascript" },
	};
	return {
		asked,
		ASSETS: {
			fetch: async (request: Request) => {
				const path = new URL(request.url).pathname;
				asked.push(`${request.method} ${path}`);
				const file = files[path];
				if (file === undefined) return new Response("missing", { status: 404 });
				return new Response(request.method === "HEAD" ? null : file.body, { headers: { "content-type": file.type } });
			},
		},
	};
}

const unused = { idFromName: () => "x", get: () => ({ fetch: async () => new Response(null, { status: 500 }) }) };

describe("the console's files", () => {
	it("serves a file the build holds as it is", async () => {
		const { ASSETS } = assets();
		const response = await consoleAsset(new Request(`${BASE}/assets/image-body-NEW.js`), { ASSETS });
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/javascript");
		expect(await response.text()).toBe("export default 1");
	});

	it("answers a chunk an older build named with a 404 that isn't cached, never the console's page", async () => {
		const { ASSETS, asked } = assets();
		const response = await routeRequest(new Request(`${BASE}/assets/image-body-CKnoALoU.js`), {
			STACK: unused,
			ASSETS,
		});
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).not.toContain("<!doctype html>");
		expect(asked).toEqual(["GET /assets/image-body-CKnoALoU.js"]);
	});

	it("gives any other path the console's page, which routes in the browser", async () => {
		const { ASSETS } = assets();
		for (const path of ["/projects/p1/compute", "/settings"]) {
			const response = await routeRequest(new Request(`${BASE}${path}`), { STACK: unused, ASSETS });
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(PAGE);
		}
		const head = await consoleAsset(new Request(`${BASE}/projects/p1`, { method: "HEAD" }), { ASSETS });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
	});

	it("doesn't answer a write to a page path with the page", async () => {
		const { ASSETS } = assets();
		const response = await consoleAsset(new Request(`${BASE}/projects/p1`, { method: "POST", body: "x" }), { ASSETS });
		expect(response.status).toBe(404);
	});
});
