/**
 * Live checks for the fixes from the PR #40 review, against a deployed spike:
 *   bun scripts/regressions.ts --base-url https://harbour-m0-cf1.<subdomain>.workers.dev
 * Needs HARBOUR_SPIKE_TOKEN.
 */
const args = process.argv.slice(2);
const baseUrl = args[args.indexOf("--base-url") + 1];
const token = process.env.HARBOUR_SPIKE_TOKEN;
if (!baseUrl || !token) throw new Error("usage: HARBOUR_SPIKE_TOKEN=... bun scripts/regressions.ts --base-url URL");

const run = `reg-${Date.now().toString(36)}`;
let failures = 0;

async function call(session: string, action: string, body?: unknown) {
  const response = await fetch(`${baseUrl}/sessions/${session}/${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

type Exec = { exitCode: number; stdout: string; stderr: string; version: string; tier: string; timings: Record<string, number> };
async function exec(session: string, command: string, tier: "isolate" | "container", containerName?: string) {
  const result = await call(session, "exec", { command, tier, ...(containerName ? { containerName } : {}) });
  return result as { status: number; body: Exec & { error?: string } };
}

function check(name: string, ok: boolean, detail: unknown) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail).slice(0, 600)}`}`);
  if (!ok) failures += 1;
}

const a = `${run}-a`;
await call(a, "setup", { workspaceId: `ws-${a}`, scenario: { name: "none", steps: [], finalAnswer: "ok", seed: { "dir/file.txt": "one\n", "real/.keep": "" } } });

// 1. A directory replaced by a file, synced into a container that holds the directory.
let r = await exec(a, "cat dir/file.txt", "container");
check("container sees dir/file.txt", r.body.stdout === "one\n", r);
r = await exec(a, "rm -r dir && printf two > dir", "isolate");
check("isolate replaces dir with a file", r.body.exitCode === 0, r);
r = await exec(a, "cat dir && test -f dir", "container");
check("container syncs a directory replaced by a file", r.status === 200 && r.body.stdout === "two" && r.body.exitCode === 0, r);

// 2. A file created through a symlinked parent in the isolate is committed.
r = await exec(a, "ln -s real alias && mktemp alias/t.XXXXXX > /dev/null && ls real | grep -c '^t\\.'", "isolate");
check("isolate mktemp through a symlink", r.body.stdout.trim() === "1", r);
r = await exec(a, "ls real | grep -c '^t\\.'", "container");
check("the file reached the workspace", r.body.stdout.trim() === "1", r);

// 3. Timeout kills background children instead of waiting for them.
const started = Date.now();
r = await call(a, "exec", { command: "sleep 600 & wait", tier: "container", timeoutMs: 3000 }) as typeof r;
const elapsed = Date.now() - started;
check("container timeout returns promptly", elapsed < 20_000 && r.body.exitCode === 124, { elapsed, r });
const count = (args: string) =>
  `for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c '^sleep ${args} $' || true`;
r = await exec(a, `sleep 7 >/dev/null 2>&1 & ${count("7")}`, "container");
check("control: the process count sees a running sleep", r.body.stdout.trim() === "1", r);
r = await exec(a, count("600"), "container");
check("the background child was killed with its group", r.body.stdout.trim() === "0", r);

// 4. Another session cannot use a container this session started.
const b = `${run}-b`;
await call(b, "setup", { workspaceId: `ws-${b}`, scenario: { name: "none", steps: [], finalAnswer: "ok", seed: { "dir/file.txt": "other\n" } } });
r = await exec(b, "cat dir/file.txt", "container", a);
check("container refuses another session", r.status >= 400 || r.body.exitCode !== 0 || r.body.stdout !== "two", r);

await call(a, "release", {});
await call(b, "release", {});
console.log(failures === 0 ? "all regressions pass" : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
