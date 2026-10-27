import ISOLATE_BUNDLE from "../dist/isolate.bundle.txt";
import type { ExecRequest, ExecResult, Sandbox, SandboxTier, SandboxTierRunner, WorkspaceVersion } from "./contracts.ts";

/**
 * Programs the isolate tier cannot run. A command that names one anywhere runs in the container. just-bash has rg, jq,
 * curl, sed, awk and a browser-excluded python3; python is listed here because the browser bundle leaves it out.
 */
const CONTAINER_PROGRAMS = new Set([
  "git",
  "gh",
  "bun",
  "bunx",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "python",
  "python3",
  "pip",
  "pip3",
  "make",
  "cargo",
  "go",
]);

/** The words in command position of each simple command; good enough for routing, not a parser. */
export function commandWords(command: string): string[] {
  const words: string[] = [];
  for (const segment of command.split(/&&|\|\||[;|&\n()]|\$\(|`/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    // Skip assignments and wrappers: `FOO=1 git status`, `env git status`, `time git status`.
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "") || ["env", "time", "exec", "sudo", "command"].includes(tokens[i] ?? "")))
      i += 1;
    const word = tokens[i];
    if (word !== undefined) words.push(word.replace(/^.*\//, ""));
  }
  return words;
}

export function routeCommand(command: string): SandboxTier {
  if (/^\s*#\s*harbour:container\b/.test(command)) return "container";
  return commandWords(command).some((word) => CONTAINER_PROGRAMS.has(word)) ? "container" : "isolate";
}

type IsolateStub = {
  exec(request: ExecRequest & { base: WorkspaceVersion }): Promise<ExecResult & { isolate: { bootedAt: number; calls: number } }>;
  ping(): Promise<{ bootedAt: number; calls: number }>;
};

/** Dynamic Worker tier: just-bash in a Worker loaded at runtime, with only the workspace and vault bindings. */
export class IsolateTier implements SandboxTierRunner {
  readonly tier = "isolate" as const;
  readonly #loaderId: string;

  constructor(
    private readonly env: Env,
    private readonly exports: Cloudflare.Exports,
    private readonly sessionId: string,
    private readonly workspaceId: string,
    /** Changes the loader ID, so the next exec loads a fresh isolate. The cold-start harness sets it. */
    generation = "0",
  ) {
    this.#loaderId = `harbour-m0-isolate:${sessionId}:${generation}:${BUNDLE_ID}`;
  }

  #stub(): IsolateStub {
    const worker = this.env.LOADER.get(this.#loaderId, async () => ({
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "isolate.js",
      modules: { "isolate.js": ISOLATE_BUNDLE },
      env: {
        WORKSPACE: this.exports.WorkspaceGateway({ props: { workspaceId: this.workspaceId } }),
      },
      // Every fetch() from the isolate, including just-bash's curl, goes to the vault. No other way out.
      globalOutbound: this.exports.VaultGateway({ props: { sessionId: this.sessionId, tier: "isolate" } }),
    }));
    return worker.getEntrypoint("HarbourIsolate") as unknown as IsolateStub;
  }

  async exec(request: ExecRequest, base: WorkspaceVersion): Promise<ExecResult> {
    const started = performance.now();
    const result = await this.#stub().exec({ ...request, base });
    const total = Math.round((performance.now() - started) * 10) / 10;
    return { ...result, timings: { ...result.timings, "isolate.call": total } };
  }

  async ping(): Promise<{ bootedAt: number; calls: number }> {
    return this.#stub().ping();
  }

  async release(): Promise<void> {
    // Isolates are evicted by the runtime; nothing to release.
  }
}

/** Container tier: one Container DO per session, durable_object scheduling policy. */
export class ContainerTier implements SandboxTierRunner {
  readonly tier = "container" as const;

  constructor(
    private readonly env: Env,
    private readonly sessionId: string,
    private readonly workspaceId: string,
    private readonly containerName = sessionId,
  ) {}

  async exec(request: ExecRequest, base: WorkspaceVersion): Promise<ExecResult> {
    const started = performance.now();
    const stub = this.env.CONTAINER.getByName(this.containerName);
    const result = await stub.exec({ ...request, base, sessionId: this.sessionId, workspaceId: this.workspaceId });
    const total = Math.round((performance.now() - started) * 10) / 10;
    return { ...result, timings: { ...result.timings, "container.call": total } } as ExecResult;
  }

  async release(): Promise<void> {
    await this.env.CONTAINER.getByName(this.containerName).release();
  }
}

/**
 * The one Sandbox the session sees. It routes by command and keeps the workspace head: every exec starts from the
 * current head and moves it to the version the tier committed, so each tier sees the other's last write.
 */
export class HarbourSandbox implements Sandbox {
  constructor(
    private readonly tiers: Readonly<Record<SandboxTier, SandboxTierRunner>>,
    private readonly head: { get(): WorkspaceVersion; set(version: WorkspaceVersion): void },
  ) {}

  route(command: string): SandboxTier {
    return routeCommand(command);
  }

  async exec(request: ExecRequest & { tier?: SandboxTier }): Promise<ExecResult> {
    const tier = request.tier ?? this.route(request.command);
    const result = await this.tiers[tier].exec(request, this.head.get());
    this.head.set(result.version);
    return result;
  }

  async release(): Promise<void> {
    await Promise.all(Object.values(this.tiers).map((tier) => tier.release()));
  }
}

/** Changes whenever the bundle changes, so a deploy never reuses an isolate with old code. */
const BUNDLE_ID = (() => {
  let hash = 2166136261;
  for (let i = 0; i < ISOLATE_BUNDLE.length; i += 997) hash = Math.imul(hash ^ ISOLATE_BUNDLE.charCodeAt(i), 16777619);
  return `${ISOLATE_BUNDLE.length.toString(36)}${(hash >>> 0).toString(36)}`;
})();
