// The router's own rules: matching by method and path, checking path parameters, query and body against the route's
// schemas before a handler runs, and answering with the route's status.
import { HarbourError, isHarbourError } from "@harbour/contracts";
import Type from "typebox";
import { describe, expect, it } from "vitest";
import { createRouter, defineRoute } from "../src/index.ts";

const Thing = Type.Object({ id: Type.String(), size: Type.Integer() }, { title: "Thing" });

const routes = {
	makeThing: defineRoute({
		operationId: "makeThing",
		method: "POST",
		path: "/things",
		tag: "things",
		summary: "Make a thing",
		body: Type.Object({ size: Type.Integer({ minimum: 1 }), note: Type.Optional(Type.String()) }),
		answer: { status: 201, description: "Made.", schema: Thing },
		errors: ["invalid"],
	}),
	findThings: defineRoute({
		operationId: "findThings",
		method: "GET",
		path: "/things",
		tag: "things",
		summary: "Find things",
		query: Type.Object({
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
			label: Type.Optional(Type.Record(Type.String(), Type.String())),
		}),
		answer: { status: 200, description: "Found.", schema: Type.Object({ seen: Type.Unknown() }) },
		errors: ["invalid"],
	}),
	dropThing: defineRoute({
		operationId: "dropThing",
		method: "POST",
		path: "/things/{thingId}/drop",
		tag: "things",
		summary: "Drop a thing",
		params: Type.Object({ thingId: Type.String({ minLength: 1 }) }),
		answer: { status: 204, description: "Dropped." },
		errors: ["not_found"],
	}),
	streamThing: defineRoute({
		operationId: "streamThing",
		method: "GET",
		path: "/things/{thingId}/stream",
		tag: "things",
		summary: "Stream a thing",
		params: Type.Object({ thingId: Type.String() }),
		answer: { status: 200, description: "A stream." },
		errors: [],
	}),
};

function setUp() {
	const calls: { route: string; ctx: string; input: unknown }[] = [];
	const router = createRouter(routes, {
		makeThing: async (ctx: string, input) => {
			calls.push({ route: "makeThing", ctx, input });
			return { id: "t1", size: input.body.size };
		},
		findThings: async (ctx: string, input) => {
			calls.push({ route: "findThings", ctx, input });
			return { seen: input.query };
		},
		dropThing: async (ctx: string, input) => {
			calls.push({ route: "dropThing", ctx, input });
			if (input.params.thingId === "missing") throw new HarbourError("not_found", "No such thing");
			return undefined;
		},
		streamThing: async () => new Response("streaming", { status: 200, headers: { "content-type": "text/plain" } }),
	});
	const send = (method: string, path: string, body?: string) =>
		router("caller", new Request(`https://harbour.test${path}`, { method, ...(body === undefined ? {} : { body }) }));
	return { calls, send };
}

async function refusal(promise: Promise<unknown>): Promise<HarbourError> {
	try {
		await promise;
	} catch (error) {
		if (isHarbourError(error)) return error;
		throw error;
	}
	throw new Error("expected a refusal");
}

describe("router", () => {
	it("answers a route with its status and the handler's output as JSON", async () => {
		const { send, calls } = setUp();
		const response = await send("POST", "/v1/things", JSON.stringify({ size: 3 }));
		expect(response?.status).toBe(201);
		expect(response?.headers.get("content-type")).toContain("application/json");
		expect(response?.headers.get("cache-control")).toBe("no-store");
		expect(await response?.json()).toEqual({ id: "t1", size: 3 });
		expect(calls).toEqual([{ route: "makeThing", ctx: "caller", input: { params: {}, query: {}, body: { size: 3 } } }]);
	});

	it("leaves a request it has no route for to the server's other routes", async () => {
		const { send, calls } = setUp();
		expect(await send("DELETE", "/v1/things")).toBeUndefined();
		expect(await send("GET", "/v1/other")).toBeUndefined();
		expect(await send("GET", "/v2/things")).toBeUndefined();
		expect(await send("GET", "/v1/things/a/b/drop")).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("refuses a body that fails the schema, naming what is wrong, before the handler runs", async () => {
		const { send, calls } = setUp();
		const error = await refusal(send("POST", "/v1/things", JSON.stringify({ size: 0 })));
		expect(error.code).toBe("invalid");
		expect(error.message).toContain("body size");
		expect((await refusal(send("POST", "/v1/things", "{"))).message).toBe("The body is not JSON");
		expect((await refusal(send("POST", "/v1/things", "[1]"))).message).toBe("The body must be a JSON object");
		expect((await refusal(send("POST", "/v1/things", ""))).message).toContain("size");
		expect(calls).toEqual([]);
	});

	it("drops body properties the schema doesn't name", async () => {
		const { send, calls } = setUp();
		await send("POST", "/v1/things", JSON.stringify({ size: 2, note: "kept", organisationId: "someone-else" }));
		expect(calls[0]?.input).toEqual({ params: {}, query: {}, body: { size: 2, note: "kept" } });
	});

	it("refuses a body over the limit", async () => {
		const router = createRouter(routes, setUpHandlers(), { maxBodyBytes: 16 });
		const error = await refusal(
			router("caller", new Request("https://harbour.test/v1/things", { method: "POST", body: "x".repeat(17) })),
		);
		expect(error.message).toBe("The body is larger than 16 bytes");
	});

	it("converts query values by the schema and gathers `name.key` into a record", async () => {
		const { send } = setUp();
		const response = await send("GET", "/v1/things?limit=5&label.team=core&label.task=T-1&extra=1");
		expect(await response?.json()).toEqual({ seen: { limit: 5, label: { team: "core", task: "T-1" } } });
		expect((await refusal(send("GET", "/v1/things?limit=50"))).code).toBe("invalid");
		expect((await refusal(send("GET", "/v1/things?limit=many"))).message).toContain("query limit");
	});

	it("decodes path parameters and answers 204 with no body", async () => {
		const { send, calls } = setUp();
		const response = await send("POST", "/v1/things/a%2Fb/drop");
		expect(response?.status).toBe(204);
		expect(await response?.text()).toBe("");
		expect(calls[0]?.input).toMatchObject({ params: { thingId: "a/b" } });
		expect((await refusal(send("POST", "/v1/things/%E0%A4%A/drop"))).message).toBe("The path is not valid");
	});

	it("passes a handler's error through for the server to answer", async () => {
		const { send } = setUp();
		expect((await refusal(send("POST", "/v1/things/missing/drop"))).code).toBe("not_found");
	});

	it("sends a handler's own response as it is", async () => {
		const { send } = setUp();
		const response = await send("GET", "/v1/things/t1/stream");
		expect(await response?.text()).toBe("streaming");
	});
});

function setUpHandlers() {
	return {
		makeThing: async () => ({ id: "t", size: 1 }),
		findThings: async () => ({ seen: null }),
		dropThing: async () => undefined,
		streamThing: async () => new Response(null),
	};
}
