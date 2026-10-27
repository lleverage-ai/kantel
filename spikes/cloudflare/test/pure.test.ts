import { describe, expect, test } from "bun:test";
import type { WorkspaceManifest } from "../src/contracts.ts";
import { containsSecret, REDACTED, redactText } from "../src/redact.ts";
import { commandWords, routeCommand } from "../src/sandbox.ts";
import { diffManifests, normalisePath } from "../src/workspace.ts";

describe("routeCommand", () => {
  test.each([
    ["ls -la && cat a.txt", "isolate"],
    ["curl -sS https://example.com | jq .", "isolate"],
    ["rg foo src | head", "isolate"],
    ["git status", "container"],
    ["cd repo && git log --oneline", "container"],
    ["FOO=1 bun test", "container"],
    ["echo $(node -v)", "container"],
    ["/usr/bin/python3 x.py", "container"],
    ["# harbour:container\ncurl -sS https://example.com", "container"],
    ["echo git is not run here", "isolate"],
  ])("%s -> %s", (command, tier) => {
    expect(routeCommand(command)).toBe(tier as "isolate" | "container");
  });

  test("commandWords finds every simple command", () => {
    expect(commandWords("a | b && c; env X=1 d || (e)")).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("workspace helpers", () => {
  test("normalisePath", () => {
    expect(normalisePath("/workspace/./a//b/../c.txt")).toBe("workspace/a/c.txt");
    expect(normalisePath("../../etc/passwd")).toBe("etc/passwd");
  });

  const manifest = (version: string, entries: Record<string, string>): WorkspaceManifest => ({
    workspaceId: "w",
    version,
    entries: Object.fromEntries(Object.entries(entries).map(([path, hash]) => [path, { path, hash, size: 1, mode: 0o644 }])),
  });

  test("diffManifests from empty puts everything", () => {
    const diff = diffManifests(undefined, manifest("v1", { a: "1", b: "2" }));
    expect(diff.put.map((e) => e.path).sort()).toEqual(["a", "b"]);
    expect(diff.remove).toEqual([]);
  });

  test("diffManifests puts changed, removes deleted, skips same", () => {
    const diff = diffManifests(manifest("v1", { a: "1", b: "2", c: "3" }), manifest("v2", { a: "1", b: "9", d: "4" }));
    expect(diff.put.map((e) => e.path).sort()).toEqual(["b", "d"]);
    expect(diff.remove).toEqual(["c"]);
  });

  test("diffManifests for a directory replaced by a file", () => {
    const diff = diffManifests(manifest("v1", { "dir/file.txt": "1" }), manifest("v2", { dir: "2" }));
    expect(diff.remove).toEqual(["dir/file.txt"]);
    expect(diff.put.map((e) => e.path)).toEqual(["dir"]);
  });
});

describe("vault redaction", () => {
  const secret = 'canary"with\\escapes&<x>';
  const html = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  test("redacts the literal value", () => {
    expect(redactText(`a ${secret} b`, secret)).toEqual({ text: `a ${REDACTED} b`, redactions: 1 });
  });

  test("redacts a JSON echo, which escapes quotes and backslashes", () => {
    const echoed = JSON.stringify({ headers: { "x-harbour-vault": secret } });
    const clean = redactText(echoed, secret);
    expect(clean.redactions).toBe(1);
    expect(JSON.parse(clean.text).headers["x-harbour-vault"]).toBe(REDACTED);
  });

  test("redacts URL, base64 and HTML encodings", () => {
    const encoded = [encodeURIComponent(secret), btoa(secret), html(secret)];
    expect(redactText(encoded.join(" "), secret).text).toBe([REDACTED, REDACTED, REDACTED].join(" "));
  });

  test("finds the value in a binary body", () => {
    const bytes = new Uint8Array([0, 1, ...new TextEncoder().encode(JSON.stringify(secret)), 255]);
    expect(containsSecret(bytes, secret)).toBe(true);
    expect(containsSecret(new Uint8Array([0, 1, 2]), secret)).toBe(false);
  });
});
