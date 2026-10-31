import { describe, expect, it } from "vitest";
import {
	exceedsMessageLimit,
	isNotification,
	isRequest,
	isResponse,
	parseMessage,
	TUNNEL_MAX_MESSAGE_BYTES,
	tunnelPath,
} from "../src/protocol.ts";

describe("parseMessage", () => {
	it("reads a request, a notification and both kinds of answer", () => {
		const request = parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');
		expect(request).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		expect(request !== undefined && isRequest(request)).toBe(true);

		const notification = parseMessage('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}');
		expect(notification !== undefined && isNotification(notification)).toBe(true);

		const result = parseMessage('{"jsonrpc":"2.0","id":"a","result":{"tools":[]}}');
		expect(result !== undefined && isResponse(result)).toBe(true);

		const error = parseMessage('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}');
		expect(error).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
	});

	it("takes a result of null as an answer", () => {
		expect(parseMessage('{"jsonrpc":"2.0","id":2,"result":null}')).toEqual({ jsonrpc: "2.0", id: 2, result: null });
	});

	it.each([
		["bad JSON", "{"],
		["the liveness frame", "ping"],
		["a batch", '[{"jsonrpc":"2.0","id":1,"method":"ping"}]'],
		["no jsonrpc", '{"id":1,"method":"ping"}'],
		["the wrong version", '{"jsonrpc":"1.0","id":1,"method":"ping"}'],
		["an object id", '{"jsonrpc":"2.0","id":{},"method":"ping"}'],
		["a null request id", '{"jsonrpc":"2.0","id":null,"method":"ping"}'],
		["array params", '{"jsonrpc":"2.0","id":1,"method":"ping","params":[1]}'],
		["both result and error", '{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":1,"message":"x"}}'],
		["neither result nor error", '{"jsonrpc":"2.0","id":1}'],
		["a malformed error", '{"jsonrpc":"2.0","id":1,"error":{"code":"x"}}'],
		["a result with a null id", '{"jsonrpc":"2.0","id":null,"result":{}}'],
		["a method that isn't a string", '{"jsonrpc":"2.0","id":1,"method":3}'],
	])("refuses %s", (_name, text) => {
		expect(parseMessage(text)).toBeUndefined();
	});
});

describe("exceedsMessageLimit", () => {
	it("counts UTF-8 bytes, not characters", () => {
		expect(exceedsMessageLimit("x".repeat(TUNNEL_MAX_MESSAGE_BYTES))).toBe(false);
		expect(exceedsMessageLimit("x".repeat(TUNNEL_MAX_MESSAGE_BYTES + 1))).toBe(true);
		// Two bytes each in UTF-8: half the limit's characters fill it.
		expect(exceedsMessageLimit("é".repeat(TUNNEL_MAX_MESSAGE_BYTES / 2))).toBe(false);
		expect(exceedsMessageLimit("é".repeat(TUNNEL_MAX_MESSAGE_BYTES / 2 + 1))).toBe(true);
	});
});

describe("tunnelPath", () => {
	it("is the connect route under the server", () => {
		expect(tunnelPath("ts_1")).toBe("/v1/tool-servers/ts_1/connect");
	});
});
