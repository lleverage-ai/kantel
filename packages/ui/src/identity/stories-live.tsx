// The sign-in screen on the real thing, in the page, for the workbench's Live story: the identity lane's OTP handler
// and identity routes over an in-memory directory, with an inbox standing in for the mail. Story-only; not exported
// from the library.

import type { CallContext, MeResponse } from "@harbour/contracts";
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
import { clockTime } from "../primitives/format.ts";
import { Field, FieldList, Panel } from "../primitives/surface.tsx";
import { SignInScreen } from "./sign-in.tsx";
import type { SignInApi } from "./sign-in-model.ts";
import { SignedInAs } from "./signed-in-as.tsx";

const bootstrap: CallContext = { actor: { kind: "system", component: "workbench" }, organisationId: "bootstrap" };
export const LIVE_INVITED = "ada@harbour.test";

/** A mailer that tells the page what it sent. */
class InboxMailer implements OtpMailer {
	readonly sent: OtpMessage[] = [];
	onSend: (() => void) | undefined;
	async send(message: OtpMessage): Promise<void> {
		this.sent.push(message);
		this.onSend?.();
	}
}

export type LiveWorld = {
	readonly api: SignInApi;
	readonly mailer: InboxMailer;
	readonly me: () => Promise<MeResponse>;
};

/** One invited person, Ada, and the OTP and identity routes served by their real handlers through an in-page fetch. */
export async function createLiveWorld(): Promise<LiveWorld> {
	const identity = createMemoryIdentity();
	const ada = await identity.createUser(bootstrap, { name: "Ada Lovelace", email: LIVE_INVITED });
	await identity.createOrganisation(bootstrap, { name: "Harbour", admin: { kind: "user", userId: ada.id } });
	const stores = createMemoryOtpStores();
	const mailer = new InboxMailer();
	const otp = createEmailOtp({ identity, ...stores, mailer });
	const otpRoutes = createOtpHandler({ otp });
	const identityRoutes = createIdentityHandler({
		identity,
		authenticator: createAuthenticator({ identity, providers: [harbourSessionProvider(stores)] }),
		signIn: ["email_otp"],
	});
	let session: string | undefined;
	const client = createIdentityClient({
		baseUrl: "https://harbour.workbench",
		fetch: async (input, init) => {
			const request = new Request(input, init);
			return new URL(request.url).pathname.startsWith("/auth/") ? otpRoutes(request) : identityRoutes(request);
		},
		headers: (): Record<string, string> => (session === undefined ? {} : { authorization: `Bearer ${session}` }),
	});
	return {
		mailer,
		api: {
			start: (email) => client.startOtp(email),
			async verify(email, code) {
				session = (await client.verifyOtp(email, code)).token;
			},
		},
		me: () => client.me(),
	};
}

export function LiveSignIn() {
	const [world, setWorld] = useState<LiveWorld>();
	const [mail, setMail] = useState<readonly OtpMessage[]>([]);
	const [me, setMe] = useState<MeResponse>();
	useEffect(() => {
		let live = true;
		void createLiveWorld().then((made) => {
			if (!live) return;
			made.mailer.onSend = () => setMail([...made.mailer.sent]);
			setWorld(made);
		});
		return () => {
			live = false;
		};
	}, []);
	if (world === undefined) return null;
	return (
		<div className="hb-story-live">
			<div className="hb-story-sign-in">
				<SignInScreen api={world.api} onSignedIn={() => void world.me().then(setMe)} />
			</div>
			<Panel header={<span>Inbox</span>} className="hb-story-inbox" aria-label="Inbox">
				<p className="hb-story-note">Only {LIVE_INVITED} is invited. Anyone else gets the same answer and no email.</p>
				{mail.length === 0 ? (
					<p className="hb-story-note">No email yet.</p>
				) : (
					<FieldList>
						{[...mail].reverse().map((message) => (
							<Field
								key={`${message.code}-${message.expiresAt}`}
								label={message.to}
								extra={`Until ${clockTime(message.expiresAt, Date.now())}`}
							>
								<span className="hb-story-code">{message.code}</span>
							</Field>
						))}
					</FieldList>
				)}
				{me === undefined ? null : (
					<SignedInAs name={me.name} {...(me.email === undefined ? {} : { email: me.email })} />
				)}
			</Panel>
		</div>
	);
}
