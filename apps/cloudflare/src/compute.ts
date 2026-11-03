/**
 * The compute API on the Worker: `@kantel/compute`'s routes under `/v1` (accounts and organisations, sandboxes,
 * commands and files, snapshots, scoped `ksk_` keys, the egress proxy, webhooks, OpenTelemetry and hosts), served by
 * the stack object beside identity and audit, so the console this Worker serves works against it as a self-hosted
 * install's does.
 *
 * - **Records:** the compute store contract (`ComputeStore`) over SQL, `@kantel/compute/sql`, the same store the
 *   self-hosted gateway keeps in Postgres. Here it is the stack object's own SQLite (`objectSqlDriver`): one object
 *   answers every request, so there is one writer, and the records outlast a restart or a deploy.
 * - **Sandboxes:** the stub backend (`@kantel/compute/stub`), a just-bash shell over files in the object's memory, as a
 *   self-hosted gateway runs with no hosts. Kantel's hosts don't join this deployment yet. The object's memory goes
 *   when Cloudflare evicts it or a deploy replaces it, while the records stay: `revivingStub` then gives a sandbox the
 *   records still have a fresh, empty machine on its next call, rather than failing every call on it.
 * - **People:** whoever the stack's authenticator signs in (Cloudflare Access, or an email code on the public origin)
 *   is a compute person under their user ID, and an admin of the deployment's own organisation (the bootstrap's) is the
 *   compute plane's super-admin, as self-hosted. With open sign-up everyone administers a personal space of their own;
 *   that makes nobody a super-admin. An identity
 *   `ktk_` key is not a compute caller; the compute API's own `ksk_` keys are.
 *
 * Its timers (webhook deliveries every second, the OpenTelemetry export every minute) run only while requests keep
 * coming (`IDLE_MS`), so they never keep the object awake on their own; each request's sweep and a delivery's next
 * attempt catch up when the next one comes.
 *
 * Portable: no Cloudflare APIs, so the tests run it in Node over `node:sqlite`.
 */
import {
	type Collection,
	type ComputeApi,
	type ComputeStore,
	createComputeApi,
	createMemoryStore,
	type PersonIdentity,
	type SandboxBackend,
	type StoredSandbox,
} from "@kantel/compute";
import { createSqlComputeStore, migrateComputeStore } from "@kantel/compute/sql";
import { createStubBackend, STUB_HOST_ID } from "@kantel/compute/stub";
import {
	type Authenticator,
	callContextFor,
	type IdentityDirectory,
	isKantelError,
	type KantelError,
} from "@kantel/contracts";
import type { SqlDriver } from "@kantel/sql";
import { HOSTED_PORTS_DOMAIN } from "./config.ts";

/** Where Cloudflare Access puts the signed-in person's token on each request it lets through. */
const ACCESS_ASSERTION = "cf-access-jwt-assertion";

/**
 * The request with Access's token as its bearer too, when it has an Access token and no `Authorization`. The console
 * sends no credential of its own behind Access (the edge signs the browser in with its cookie), and the compute API
 * asks every call for a bearer before it signs a person in. Nothing else changes: the stack's authenticator still reads
 * the person from `Cf-Access-Jwt-Assertion` (a bearer that is neither an API key nor a Kantel session never outranks
 * it), so the identity and audit routes answer as before.
 */
export function withAccessBearer(request: Request): Request {
	if (request.headers.has("authorization")) return request;
	const token = request.headers.get(ACCESS_ASSERTION)?.trim() ?? "";
	if (token === "" || /\s/.test(token)) return request;
	const headers = new Headers(request.headers);
	headers.set("authorization", `Bearer ${token}`);
	return new Request(request, { headers });
}

/** How often webhook deliveries that are due are sent, while requests come. */
const WEBHOOK_INTERVAL_MS = 1000;
/** How often telemetry is exported, while requests come. */
const TELEMETRY_INTERVAL_MS = 60_000;
/** How long after the last compute request the timers stop. */
export const IDLE_MS = 5 * 60_000;

export interface StackCompute {
	/** Answers a compute route, or resolves `undefined` for any other request. */
	fetch(request: Request): Promise<Response | undefined>;
	readonly api: ComputeApi;
	/** What `GET /v1/deployment`-style logs say about it. */
	readonly binding: string;
	close(): Promise<void>;
}

export interface StackComputeOptions {
	readonly authenticator: Authenticator;
	/** Who holds which role: an organisation admin who signs in is the compute plane's super-admin. */
	readonly identity: Pick<IdentityDirectory, "authorize">;
	/**
	 * The deployment's own organisation: only its admins are super-admins. Absent, any organisation's admin is (tests
	 * with one organisation).
	 */
	readonly adminOrganisationId?: string;
	/** Where the records are: the stack object's SQLite. Absent, in memory (tests). */
	readonly sql?: SqlDriver;
	readonly now?: () => number;
	/** For webhook deliveries and telemetry exports. Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/**
	 * The domain port URLs are under, `{port}-{subdomain}.{domain}`. Default `HOSTED_PORTS_DOMAIN` (`ports.kantel.dev`).
	 * The stub backend only names the URLs: nothing serves them until hosts join this deployment.
	 */
	readonly portsDomain?: string;
}

/**
 * The person a sign-in is, or undefined for a key or no sign-in. As the self-hosted gateway does
 * (`apps/selfhosted/src/gateway/compute.ts`): a person's sign-in carries no role of its own, so `identity` says
 * whether they administer the organisation.
 */
async function personOf(
	authenticator: Authenticator,
	identity: Pick<IdentityDirectory, "authorize">,
	request: Request,
	adminOrganisationId: string | undefined,
): Promise<PersonIdentity | undefined> {
	let caller: Awaited<ReturnType<Authenticator["authenticate"]>>;
	try {
		caller = await authenticator.authenticate(request);
	} catch {
		return undefined;
	}
	if (caller.actor.kind !== "human") return undefined;
	// An admin of a personal space (anyone who signed up) or of another organisation is not the deployment's.
	const superAdmin =
		(adminOrganisationId === undefined || caller.organisationId === adminOrganisationId) &&
		(await identity.authorize(callContextFor(caller), "admin").then(
			() => true,
			() => false,
		));
	return { userId: caller.actor.userId, name: caller.actor.userId, superAdmin };
}

/** The compute API over the stub backend, its records in `sql` (or memory), signed in with `authenticator`. */
export async function createStackCompute(options: StackComputeOptions): Promise<StackCompute> {
	let store: ComputeStore;
	if (options.sql === undefined) store = createMemoryStore();
	else {
		await migrateComputeStore(options.sql);
		store = createSqlComputeStore(options.sql);
	}
	const now = options.now ?? Date.now;
	const api = createComputeApi({
		store,
		backend: revivingStub(
			createStubBackend({ sandboxDomain: options.portsDomain ?? HOSTED_PORTS_DOMAIN }),
			store.sandboxes,
		),
		authenticatePerson: (request) =>
			personOf(options.authenticator, options.identity, request, options.adminOrganisationId),
		mode: "hosted",
		now,
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});
	const timers = whileBusy(api, now);
	return {
		api,
		binding: `${options.sql === undefined ? "memory" : "the stack object's SQLite"}, stub backend (experimental)`,
		async fetch(request) {
			const answer = await api.fetch(request);
			if (answer !== undefined) timers.touch();
			return answer;
		},
		async close() {
			timers.stop();
			await api.close();
		},
	};
}

/** Runs the API's timers from a request until `IDLE_MS` after the last one, then sends what telemetry is queued. */
function whileBusy(api: ComputeApi, now: () => number): { touch(): void; stop(): void } {
	let last = 0;
	let check: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		if (check === undefined) return;
		clearTimeout(check);
		check = undefined;
		api.dispatcher.stop();
		api.exporter.stop();
	};
	const watch = () => {
		check = setTimeout(() => {
			if (now() - last < IDLE_MS) return watch();
			stop();
			api.exporter.flush().catch(() => undefined);
		}, IDLE_MS / 5);
	};
	return {
		touch() {
			last = now();
			if (check !== undefined) return;
			api.dispatcher.start(WEBHOOK_INTERVAL_MS);
			api.exporter.start(TELEMETRY_INTERVAL_MS);
			watch();
		},
		stop,
	};
}

const lost = (error: unknown, prefix: string): error is KantelError =>
	isKantelError(error) && error.code === "not_found" && error.message.startsWith(prefix);
/** The stub's refusal for a sandbox it has no machine for (`stub-backend.ts`). */
const NO_MACHINE = "The stub has no machine for ";
/** The stub's refusal for a snapshot it doesn't hold. */
const NO_SNAPSHOT = "The stub has no snapshot ";

/**
 * The stub, for a stub whose memory can go while the records stay. A call for a sandbox it has no machine for gives that
 * sandbox a fresh machine (an empty disk, its type, size and environment from the record) and is made again; a boot
 * from a snapshot it no longer holds boots from an empty disk. Anything else, and a sandbox the records don't have,
 * fails as the stub does.
 */
export function revivingStub(stub: SandboxBackend, sandboxes: Collection<StoredSandbox>): SandboxBackend {
	const revive = async (sandboxId: string, cause: KantelError): Promise<void> => {
		const record = await sandboxes.get(sandboxId);
		if (record === undefined || record.state === "deleted") throw cause;
		const made = stub.create({
			sandboxId,
			accountId: record.accountId,
			type: record.type,
			subdomain: record.subdomain,
			...(record.size === undefined ? {} : { size: record.size }),
			...(record.image === undefined ? {} : { image: record.image }),
			env: record.env,
			eligibleHosts: [STUB_HOST_ID],
		});
		// Another call revived it first.
		await made.catch((error: unknown) => {
			if (!isKantelError(error) || error.code !== "conflict") throw error;
		});
	};
	const onMachine = async <T>(sandboxId: string, call: () => Promise<T>): Promise<T> => {
		try {
			return await call();
		} catch (error) {
			if (!lost(error, NO_MACHINE)) throw error;
			await revive(sandboxId, error);
			return call();
		}
	};
	/** `call` with `options`, or without its snapshot when the stub no longer holds it. */
	const fromAny = async <O extends { readonly fromSnapshot?: string }, T>(
		options: O,
		call: (options: O) => Promise<T>,
	): Promise<T> => {
		try {
			return await call(options);
		} catch (error) {
			if (!lost(error, NO_SNAPSHOT) || options.fromSnapshot === undefined) throw error;
			const { fromSnapshot: _gone, ...rest } = options;
			return call(rest as O);
		}
	};
	return {
		...stub,
		create: (spec) => fromAny(spec, (given) => stub.create(given)),
		start: (id, options) => onMachine(id, () => fromAny(options, (given) => stub.start(id, given))),
		stop: (id, options) => onMachine(id, () => stub.stop(id, options)),
		resume: (id, options) => onMachine(id, () => fromAny(options, (given) => stub.resume(id, given))),
		recover: (id, options) => onMachine(id, () => fromAny(options, (given) => stub.recover(id, given))),
		fork: (source, targets) =>
			source.snapshot === undefined
				? onMachine(source.sandboxId, () => stub.fork(source, targets))
				: stub.fork(source, targets),
		exec: (id, request) => onMachine(id, () => stub.exec(id, request)),
		readFile: (id, path, range) => onMachine(id, () => stub.readFile(id, path, range)),
		writeFile: (id, path, content, mode) => onMachine(id, () => stub.writeFile(id, path, content, mode)),
		deleteFile: (id, path) => onMachine(id, () => stub.deleteFile(id, path)),
		listFiles: (id, path) => onMachine(id, () => stub.listFiles(id, path)),
		takeSnapshot: (id) => onMachine(id, () => stub.takeSnapshot(id)),
		exposePort: (id, port, options) => onMachine(id, () => stub.exposePort(id, port, options)),
		openSsh: (id, options) => onMachine(id, () => stub.openSsh(id, options)),
		openDesktop: (id, options) => onMachine(id, () => stub.openDesktop(id, options)),
		openBrowser: (id, options) => onMachine(id, () => stub.openBrowser(id, options)),
		usage: (id) => onMachine(id, () => stub.usage(id)),
	};
}
