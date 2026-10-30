// The API keys page on the real thing, in the page, for the workbench's Live story: the identity routes'
// handler and client over an in-memory directory, with Ada signed in as the organisation's admin through the email
// one-time PIN routes. A side panel calls `GET /v1/me` with the last key issued, so a revoked key can be seen refused
// on its next call. Story-only; not exported from the library.

import type { CallContext, HeldRole } from "@harbour/contracts";
import { createAuthenticator } from "@harbour/identity/authenticator";
import { createIdentityClient, createIdentityHandler } from "@harbour/identity/http";
import { createMemoryIdentity } from "@harbour/identity/memory";
import {
	createEmailOtp,
	createMemoryOtpStores,
	harbourSessionProvider,
	type OtpMailer,
	type OtpMessage,
} from "@harbour/identity/otp";
import { createOtpHandler } from "@harbour/identity/otp/http";
import { useEffect, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { Panel } from "../primitives/surface.tsx";
import { ApiKeysPage } from "./api-keys.tsx";
import type { ApiKeysApi, KeyProject } from "./api-keys-model.ts";
import { liveFrame, pageFrame, sidebarFrame, storyNote } from "./story-frames.ts";

const bootstrap: CallContext = { actor: { kind: "system", component: "workbench" }, organisationId: "bootstrap" };
const ADA = "ada@harbour.test";

/** Hands over the next code sent; the OTP routes send on a later task, after their response. */
class Inbox implements OtpMailer {
	#waiting: ((message: OtpMessage) => void) | undefined;
	next(): Promise<OtpMessage> {
		return new Promise((resolve) => {
			this.#waiting = resolve;
		});
	}
	async send(message: OtpMessage): Promise<void> {
		this.#waiting?.(message);
	}
}

interface KeysWorld {
	readonly api: ApiKeysApi;
	readonly projects: readonly KeyProject[];
	readonly roles: readonly HeldRole[];
	/** The last secret issued, kept by the story only so the side panel can call with it. */
	lastSecret(): string | undefined;
	/** `GET /v1/me` with the last key: its status and who it says the caller is. */
	callWithKey(): Promise<string>;
}

async function createKeysWorld(): Promise<KeysWorld> {
	const identity = createMemoryIdentity();
	const ada = await identity.createUser(bootstrap, { name: "Ada Lovelace", email: ADA });
	const org = await identity.createOrganisation(bootstrap, {
		name: "Harbour",
		admin: { kind: "user", userId: ada.id },
	});
	const asAda: CallContext = { actor: { kind: "human", userId: ada.id }, organisationId: org.id };
	await identity.createProject(asAda, { name: "Harbour" });
	await identity.createProject(asAda, { name: "Sal" });
	const stores = createMemoryOtpStores();
	const inbox = new Inbox();
	const otpRoutes = createOtpHandler({ otp: createEmailOtp({ identity, ...stores, mailer: inbox }) });
	const routes = createIdentityHandler({
		identity,
		authenticator: createAuthenticator({ identity, providers: [harbourSessionProvider(stores)] }),
		signIn: ["email_otp"],
	});
	const serve = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const request = new Request(input, init);
		return new URL(request.url).pathname.startsWith("/auth/") ? otpRoutes(request) : routes(request);
	};
	let session: string | undefined;
	const client = createIdentityClient({
		baseUrl: "https://harbour.workbench",
		fetch: serve,
		headers: (): Record<string, string> => (session === undefined ? {} : { authorization: `Bearer ${session}` }),
	});
	const mail = inbox.next();
	await client.startOtp(ADA);
	session = (await client.verifyOtp(ADA, (await mail).code)).token;
	const [me, projects] = await Promise.all([client.me(), client.allProjects()]);
	let secret: string | undefined;
	return {
		projects: projects.map((project) => ({ id: project.id, name: project.name })),
		roles: me.roles,
		api: {
			list: () => client.listApiKeys(),
			async create(input) {
				const issued = await client.createApiKey(input);
				secret = issued.secret;
				return issued;
			},
			revoke: (keyId) => client.revokeApiKey(keyId),
		},
		lastSecret: () => secret,
		async callWithKey() {
			if (secret === undefined) return "Issue a key first.";
			const response = await serve("https://harbour.workbench/v1/me", {
				headers: { authorization: `Bearer ${secret}` },
			});
			const body = (await response.json()) as { name?: string; error?: { message?: string } };
			return response.ok
				? `${response.status}: signed in as ${body.name}`
				: `${response.status}: ${body.error?.message ?? "refused"}`;
		},
	};
}

export function ApiKeysLive() {
	const [world, setWorld] = useState<KeysWorld>();
	const [answer, setAnswer] = useState<string>();
	const [calling, setCalling] = useState(false);
	useEffect(() => {
		let live = true;
		void createKeysWorld().then((made) => live && setWorld(made));
		return () => {
			live = false;
		};
	}, []);
	if (world === undefined) return null;
	const call = async () => {
		setCalling(true);
		try {
			setAnswer(await world.callWithKey());
		} finally {
			setCalling(false);
		}
	};
	return (
		<div className={liveFrame}>
			<div className={pageFrame}>
				<ApiKeysPage api={world.api} projects={world.projects} roles={world.roles} />
			</div>
			<Panel header={<span>A host app</span>} aria-label="A host app">
				<div className={sidebarFrame}>
					<p className={storyNote}>
						Calls <code>GET /v1/me</code> with the last key issued here. Revoke it, then call again.
					</p>
					<Button size="sm" busy={calling} onClick={() => void call()}>
						Call with the key
					</Button>
					{answer === undefined ? null : (
						<p className={storyNote} role="status">
							{answer}
						</p>
					)}
				</div>
			</Panel>
		</div>
	);
}
