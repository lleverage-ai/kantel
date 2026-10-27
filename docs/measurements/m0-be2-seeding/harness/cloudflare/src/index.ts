// harbour-m0-seed-bench: Cloudflare side of the M0-BE2 seeding measurements.
//
// One Durable Object per measured run, so every run gets a fresh container
// (durable_object scheduling policy, standard-4 unless told otherwise).
// The DO times start -> first exec (container ready) and the seeding op, and
// the op itself (seed-op, same script as self-hosted) reports its own phases.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { DirectoryBackup, type DirectoryBackupRecord } from "@cloudflare/sandbox";

export { DirectoryBackupGateway } from "@cloudflare/sandbox";

interface Env {
	SEED_BOX: DurableObjectNamespace<SeedBox>;
	SEED: R2Bucket;
	BENCH_TOKEN: string;
}

type ImageName = "slim";

export interface RunRequest {
	image?: ImageName;
	snapshot?: string; // container snapshot id to start from instead of an image
	instance?: string;
	args: string[]; // seed-op arguments
	restoreBackup?: DirectoryBackupRecord; // restore this directory backup before the op
	r2?: boolean; // route http://r2.seed/<key> to the R2 bucket
	internet?: boolean; // only for preparing the cache snapshot (cloning public repos, npm installs)
	// preparation only:
	prep?: string; // shell script run before snapshot/backup
	snapshotName?: string;
	backupDir?: string;
	backupExclude?: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dec = new TextDecoder();

/** Serves http://r2.seed/<key> from the bucket to a container (GET streams, PUT stores). */
export class R2Gateway extends WorkerEntrypoint<Env> {
	async fetch(req: Request): Promise<Response> {
		const key = decodeURIComponent(new URL(req.url).pathname.slice(1));
		if (req.method === "PUT") {
			const len = Number(req.headers.get("content-length") ?? "0");
			if (!req.body || !len) return new Response("length required", { status: 411 });
			const fixed = new FixedLengthStream(len);
			const [, put] = await Promise.all([req.body.pipeTo(fixed.writable), this.env.SEED.put(key, fixed.readable)]);
			return Response.json({ key, size: put?.size });
		}
		const obj = await this.env.SEED.get(key);
		if (!obj) return new Response("not found", { status: 404 });
		return new Response(obj.body, { headers: { "content-length": String(obj.size) } });
	}
}

export class SeedBox extends DurableObject<Env> {
	#backups: DirectoryBackup;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// biome-ignore lint: exports typing
		const exportsAny = ctx.exports as any;
		this.#backups = new DirectoryBackup(ctx.container!, exportsAny.DirectoryBackupGateway, {
			binding: "SEED",
			prefix: "backups/",
		});
	}

	async #start(req: RunRequest) {
		const c = this.ctx.container!;
		if (c.running) await c.destroy();
		const common = {
			enableInternet: req.internet === true,
			instance: req.instance ?? "standard-4",
			entrypoint: ["sleep", "infinity"],
		};
		// The installed workers-types predate per-image references and containerSnapshot, hence the casts.
		type StartOptions = Parameters<typeof c.start>[0];
		const images = (c as unknown as { images: Record<string, string> }).images;
		if (req.snapshot) c.start({ ...common, containerSnapshot: { id: req.snapshot } } as unknown as StartOptions);
		else c.start({ ...common, image: images[req.image ?? "slim"] } as unknown as StartOptions);
		await c.setInactivityTimeout(10 * 60 * 1000);
		// exec() waits for a container that is still starting; retry a few times on early errors.
		let tries = 0;
		for (;;) {
			try {
				const p = await c.exec(["true"]);
				await p.exitCode;
				break;
			} catch (e) {
				if (++tries > 200) throw e;
				await sleep(100);
			}
		}
		if (req.r2) {
			// biome-ignore lint: exports typing
			await c.interceptOutboundHttp("r2.seed", (this.ctx.exports as any).R2Gateway({ props: {} }));
		}
		return tries;
	}

	async #exec(cmd: string[]) {
		const p = await this.ctx.container!.exec(cmd, { stderr: "pipe" });
		const out = await p.output();
		return { code: out.exitCode, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
	}

	/** One measured run on a fresh container. */
	async run(req: RunRequest) {
		const t0 = Date.now();
		const startRetries = await this.#start(req);
		const tReady = Date.now();
		let restoreMs: number | undefined;
		try {
			if (req.restoreBackup) {
				await this.#backups.restore(req.restoreBackup);
				restoreMs = Date.now() - tReady;
			}
			const r = await this.#exec(["seed-op", ...req.args]);
			const tDone = Date.now();
			if (r.code !== 0) return { ok: false, error: r.stderr.slice(-2000), code: r.code };
			const op = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
			return {
				ok: true,
				start_ready_ms: tReady - t0,
				restore_ms: restoreMs,
				op_wall_ms: tDone - tReady,
				total_ms: tDone - t0,
				start_retries: startRetries,
				op,
			};
		} finally {
			await this.ctx.container!.destroy().catch(() => {});
		}
	}

	/** Run an arbitrary prep script in a fresh container, then snapshot it or back up a directory. */
	async prepare(req: RunRequest) {
		const t0 = Date.now();
		await this.#start(req);
		try {
			const r = await this.#exec(["bash", "-euo", "pipefail", "-c", req.prep ?? "true"]);
			if (r.code !== 0) return { ok: false, stdout: r.stdout.slice(-2000), stderr: r.stderr.slice(-2000) };
			const tPrep = Date.now();
			let snapshot: unknown;
			let backup: DirectoryBackupRecord | undefined;
			if (req.snapshotName) snapshot = await this.ctx.container!.snapshotContainer({ name: req.snapshotName });
			if (req.backupDir)
				backup = await this.#backups.backup({ dir: req.backupDir, name: req.snapshotName, exclude: req.backupExclude });
			return {
				ok: true,
				prep_ms: tPrep - t0,
				save_ms: Date.now() - tPrep,
				stdout: r.stdout.slice(-4000),
				snapshot,
				backup,
			};
		} finally {
			await this.ctx.container!.destroy().catch(() => {});
		}
	}

	async deleteBackup(rec: DirectoryBackupRecord) {
		await this.#backups.delete(rec);
		return { ok: true };
	}
}

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (req.headers.get("authorization") !== `Bearer ${env.BENCH_TOKEN}`) return new Response("no", { status: 401 });
		const url = new URL(req.url);
		const name = url.searchParams.get("box") ?? crypto.randomUUID();
		const stub = env.SEED_BOX.getByName(name);
		const body = (await req.json()) as RunRequest;
		try {
			if (url.pathname === "/run") return Response.json(await stub.run(body));
			if (url.pathname === "/prepare") {
				// Preparation can take minutes: stream a heartbeat so nothing between us times out.
				const { readable, writable } = new TransformStream();
				const w = writable.getWriter();
				const te = new TextEncoder();
				const beat = setInterval(() => w.write(te.encode(" ")).catch(() => {}), 15000);
				const done = stub
					.prepare(body)
					.catch((e) => ({ ok: false, error: String((e as Error)?.stack ?? e) }))
					.then(async (r) => {
						clearInterval(beat);
						await w.write(te.encode(`\n${JSON.stringify(r)}\n`));
						await w.close();
					});
				ctx.waitUntil(done);
				return new Response(readable, { headers: { "content-type": "text/plain" } });
			}
			if (url.pathname === "/delete-backup") return Response.json(await stub.deleteBackup(body.restoreBackup!));
			if (url.pathname === "/list") {
				const l = await env.SEED.list({ prefix: url.searchParams.get("prefix") ?? "" });
				return Response.json(l.objects.map((o) => ({ key: o.key, size: o.size })));
			}
			if (url.pathname === "/delete") {
				await env.SEED.delete(url.searchParams.get("key")!);
				return Response.json({ ok: true });
			}
		} catch (e) {
			return Response.json({ ok: false, error: String((e as Error)?.stack ?? e) }, { status: 500 });
		}
		return new Response("not found", { status: 404 });
	},
};
