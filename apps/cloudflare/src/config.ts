/**
 * The gateway's configuration, read from the Worker's vars. Nothing here is secret: the Access team domain and AUD tag
 * are what every visitor's token already names, and the admin email only invites someone Access must still let in.
 */
import { KantelError } from "@kantel/contracts";
import { type OAuthClients, oauthClientsFromEnv } from "@kantel/identity/oauth";

export interface GatewayVars {
	readonly KANTEL_ACCESS_TEAM_DOMAIN?: string;
	readonly KANTEL_ACCESS_AUD?: string;
	readonly KANTEL_ADMIN_EMAIL?: string;
	/** The first admin's name, as the console shows it. Default their email. */
	readonly KANTEL_ADMIN_NAME?: string;
	/** The domain sandboxes' port URLs are under, `{port}-{subdomain}.{domain}`. Default `HOSTED_PORTS_DOMAIN`. */
	readonly KANTEL_COMPUTE_PORTS_DOMAIN?: string;
	/**
	 * The public origin, such as `https://app.kantel.dev`: a hostname with no Cloudflare Access in front, where people
	 * sign in with an email code (with KANTEL_SIGN_IN_FROM) and anyone may sign up into a personal space of their own.
	 * With KANTEL_ACCOUNT_HOSTS it is also the origin hosts dial. Unset: the Worker answers only behind Access, as before.
	 */
	readonly KANTEL_PUBLIC_URL?: string;
	/** The address sign-in codes and invites are sent from, through the `SIGN_IN_MAIL` binding. */
	readonly KANTEL_SIGN_IN_FROM?: string;
	/** How many sign-in codes and invites the Worker sends a day (UTC), at most. Default `DEFAULT_DAILY_MAIL_CAP`. */
	readonly KANTEL_SIGN_IN_DAILY_CAP?: string;
	/**
	 * Account hosts (experimental): `experimental` lets accounts add machines of their own, which dial out to this
	 * Worker at KANTEL_PUBLIC_URL and run only that account's sandboxes. Unset, empty or `off`: off, and nothing about
	 * the Worker changes.
	 */
	readonly KANTEL_ACCOUNT_HOSTS?: string;
	/**
	 * Sign-in with GitHub and with Google on the public origin, beside email codes: each provider's OAuth client, Worker
	 * secrets (`scripts/vault-secrets.ts`), never vars. A provider is on with both its ID and secret, and email sign-in.
	 */
	readonly KANTEL_GITHUB_CLIENT_ID?: string;
	readonly KANTEL_GITHUB_CLIENT_SECRET?: string;
	readonly KANTEL_GOOGLE_CLIENT_ID?: string;
	readonly KANTEL_GOOGLE_CLIENT_SECRET?: string;
}

/**
 * Mail a day, at most: 100 a day stays inside the 3,000 a month Workers Paid includes for Email Sending, so open sign-up
 * can't run up a bill however it is used.
 */
export const DEFAULT_DAILY_MAIL_CAP = 100;

/**
 * Kantel's hosted ports domain (4 Nov 2026): `kantel.run`, a registrable domain of its own, apart from the console's
 * (`app.kantel.dev`, `harbour.myslop.app`). A port's page is therefore never the same site as the console: it can't set
 * a cookie the console reads, and the console's cross-site refusal (`@kantel/identity/csrf`) refuses its writes. Port
 * names are one label under it (`3000-brave-otter-ab12cd.kantel.run`), so Cloudflare's Universal SSL certificate
 * (`kantel.run`, `*.kantel.run`) covers every one. kantel.run isn't on the Public Suffix List, so port names are one
 * site with each other: a sandbox's page can set cookies for all of kantel.run. A deployment of this Worker on another
 * domain sets KANTEL_COMPUTE_PORTS_DOMAIN to its own.
 */
export const HOSTED_PORTS_DOMAIN = "kantel.run";

/**
 * The ports domain from KANTEL_COMPUTE_PORTS_DOMAIN as `gatewayConfig` reads it (`*.` and trailing dots taken off,
 * lower case), else `HOSTED_PORTS_DOMAIN`. Never throws: routing asks it before the stack has checked the value.
 */
export function portsDomainOf(vars: Pick<GatewayVars, "KANTEL_COMPUTE_PORTS_DOMAIN">): string {
	const domain = normalisedDomain(vars.KANTEL_COMPUTE_PORTS_DOMAIN);
	return domain === "" ? HOSTED_PORTS_DOMAIN : domain;
}

/**
 * Whether `hostname` is under the ports domain: an exposed port's name, `{port}-{subdomain}.{domain}`. Any name under it
 * counts, however deep, so none of them ever reaches the console or the API; the stack answers a name that isn't a
 * port's with a 404 (`src/compute.ts` `servePort`).
 */
export function isPortName(hostname: string, domain: string): boolean {
	return hostname.toLowerCase().replace(/\.$/, "").endsWith(`.${domain}`);
}

const normalisedDomain = (value: string | undefined): string =>
	trimmed(value)
		.toLowerCase()
		.replace(/^\*?\.+|\.+$/g, "");

export interface GatewayConfig {
	/** Cloudflare Access, when people may sign in. Without it only API keys authenticate. */
	readonly access?: { readonly teamDomain: string; readonly audience: string };
	/** The person invited as the organisation's first admin. */
	readonly adminEmail?: string;
	/** The first admin's name; only used when the bootstrap invites them. */
	readonly adminName?: string;
	/** The domain port URLs are under, from KANTEL_COMPUTE_PORTS_DOMAIN. Absent, `HOSTED_PORTS_DOMAIN`. */
	readonly portsDomain?: string;
	/** Account hosts, when on: where hosts reach this Worker. */
	readonly accountHosts?: { readonly publicUrl: string };
	/**
	 * Email-code sign-in and open sign-up on the public origin. Absent unless KANTEL_PUBLIC_URL and KANTEL_SIGN_IN_FROM
	 * are both set; it then also needs the `SIGN_IN_MAIL` binding to send anything.
	 */
	readonly emailSignIn?: {
		/** The public origin, such as `https://app.kantel.dev`. */
		readonly publicUrl: string;
		readonly from: string;
		readonly dailyCap: number;
		/**
		 * The OAuth clients of the providers people may also sign in with there (GitHub, Google): those with both their
		 * ID and secret set. Absent when there are none.
		 */
		readonly oauth?: OAuthClients;
	};
}

const DNS_NAME = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const trimmed = (value: string | undefined): string => (value ?? "").trim();

/**
 * Reads the vars. The Access team domain and AUD come as a pair: one without the other is a broken deployment, and is
 * refused rather than served with sign-in silently off.
 */
export function gatewayConfig(vars: GatewayVars): GatewayConfig {
	const teamDomain = trimmed(vars.KANTEL_ACCESS_TEAM_DOMAIN);
	const audience = trimmed(vars.KANTEL_ACCESS_AUD);
	if ((teamDomain === "") !== (audience === "")) {
		throw new KantelError("invalid", "Set both KANTEL_ACCESS_TEAM_DOMAIN and KANTEL_ACCESS_AUD, or neither");
	}
	const adminEmail = trimmed(vars.KANTEL_ADMIN_EMAIL);
	if (adminEmail !== "" && !/^[^\s@]+@[^\s@]+$/.test(adminEmail)) {
		throw new KantelError("invalid", "KANTEL_ADMIN_EMAIL must be an email address");
	}
	const adminName = trimmed(vars.KANTEL_ADMIN_NAME);
	// As the self-hosted gateway reads its own: `*.` and trailing dots taken off, lower case.
	const portsDomain = normalisedDomain(vars.KANTEL_COMPUTE_PORTS_DOMAIN);
	if (portsDomain !== "" && !DNS_NAME.test(portsDomain)) {
		throw new KantelError("invalid", "KANTEL_COMPUTE_PORTS_DOMAIN is a DNS name such as ports.example.com");
	}
	// Every name under the ports domain is a port's (`src/route.ts`): the public origin under it would be unreachable.
	const publicHost = PUBLIC_ORIGIN.test(trimmed(vars.KANTEL_PUBLIC_URL))
		? new URL(trimmed(vars.KANTEL_PUBLIC_URL)).hostname
		: "";
	const ports = portsDomainOf(vars);
	if (publicHost !== "" && (publicHost === ports || publicHost.endsWith(`.${ports}`))) {
		throw new KantelError("invalid", "KANTEL_PUBLIC_URL can't be the ports domain or a name under it");
	}
	const accountHosts = accountHostsConfig(vars);
	// Set either way, the switch says the public origin may be for hosts alone: turning them off keeps it valid.
	const emailSignIn = emailSignInConfig(vars, trimmed(vars.KANTEL_ACCOUNT_HOSTS) !== "");
	const oauthVars = [
		vars.KANTEL_GITHUB_CLIENT_ID,
		vars.KANTEL_GITHUB_CLIENT_SECRET,
		vars.KANTEL_GOOGLE_CLIENT_ID,
		vars.KANTEL_GOOGLE_CLIENT_SECRET,
	];
	if (emailSignIn === undefined && oauthVars.some((value) => trimmed(value) !== "")) {
		// Off rather than refused: the Access hostname alone (harbour.myslop.app) stays as it is with the secrets on it.
		console.warn("kantel: sign-in with GitHub and Google needs KANTEL_PUBLIC_URL and KANTEL_SIGN_IN_FROM; it is off");
	}
	return {
		...(emailSignIn === undefined ? {} : { emailSignIn }),
		...(portsDomain === "" ? {} : { portsDomain }),
		...(teamDomain === "" ? {} : { access: { teamDomain, audience } }),
		...(adminEmail === "" ? {} : { adminEmail }),
		...(adminName === "" ? {} : { adminName }),
		...(accountHosts === undefined ? {} : { accountHosts }),
	};
}

/**
 * KANTEL_ACCOUNT_HOSTS and KANTEL_PUBLIC_URL. Off unless the switch says `experimental`; on, it needs the origin hosts
 * dial, and a typo in either is refused rather than leaving account hosts silently off.
 */
function accountHostsConfig(vars: GatewayVars): GatewayConfig["accountHosts"] {
	const value = trimmed(vars.KANTEL_ACCOUNT_HOSTS).toLowerCase();
	if (value === "" || value === "off") return undefined;
	if (value !== "experimental") {
		throw new KantelError("invalid", "KANTEL_ACCOUNT_HOSTS must be `experimental` or `off`");
	}
	const publicUrl = trimmed(vars.KANTEL_PUBLIC_URL);
	if (!PUBLIC_ORIGIN.test(publicUrl)) {
		throw new KantelError(
			"invalid",
			"KANTEL_ACCOUNT_HOSTS needs KANTEL_PUBLIC_URL: the origin hosts reach this Worker at, such as https://kantel.example.com",
		);
	}
	return { publicUrl: new URL(publicUrl).origin };
}

const PUBLIC_ORIGIN = /^https?:\/\/[^/?#\s]+\/?$/i;

/**
 * KANTEL_PUBLIC_URL, KANTEL_SIGN_IN_FROM and KANTEL_SIGN_IN_DAILY_CAP. Both of the first two or neither: one without the
 * other is refused rather than served with sign-in silently off. With the account hosts switch set (`accountHosts`, on
 * or off), the public origin is also where hosts dial, so it may be set alone: sign-in is then off.
 */
function emailSignInConfig(vars: GatewayVars, accountHosts: boolean): GatewayConfig["emailSignIn"] {
	const publicUrl = trimmed(vars.KANTEL_PUBLIC_URL);
	const from = trimmed(vars.KANTEL_SIGN_IN_FROM);
	if (publicUrl === "" && from === "") return undefined;
	if (accountHosts && publicUrl !== "" && from === "") {
		if (!PUBLIC_ORIGIN.test(publicUrl)) {
			throw new KantelError("invalid", "KANTEL_PUBLIC_URL is an origin such as https://app.kantel.dev");
		}
		return undefined;
	}
	if (publicUrl === "" || from === "") {
		throw new KantelError("invalid", "Set both KANTEL_PUBLIC_URL and KANTEL_SIGN_IN_FROM, or neither");
	}
	if (!PUBLIC_ORIGIN.test(publicUrl)) {
		throw new KantelError("invalid", "KANTEL_PUBLIC_URL is an origin such as https://app.kantel.dev");
	}
	if (!/^[^\s@]+@[^\s@]+$/.test(from)) throw new KantelError("invalid", "KANTEL_SIGN_IN_FROM must be an email address");
	const capText = trimmed(vars.KANTEL_SIGN_IN_DAILY_CAP);
	const dailyCap = capText === "" ? DEFAULT_DAILY_MAIL_CAP : Number(capText);
	if (!(Number.isInteger(dailyCap) && dailyCap >= 0)) {
		throw new KantelError("invalid", "KANTEL_SIGN_IN_DAILY_CAP must be a whole number");
	}
	const oauth = oauthClientsFromEnv(vars);
	return {
		publicUrl: new URL(publicUrl).origin,
		from,
		dailyCap,
		...(Object.keys(oauth).length === 0 ? {} : { oauth }),
	};
}
