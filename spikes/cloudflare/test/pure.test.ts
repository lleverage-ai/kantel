import { describe, expect, test } from "bun:test";
import type { WorkspaceManifest } from "../src/contracts.ts";
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
});
