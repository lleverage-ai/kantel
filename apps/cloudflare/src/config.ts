/**
 * The gateway's configuration, read from the Worker's vars. Nothing here is secret: the Access team domain and AUD tag
 * are what every visitor's token already names, and the admin email only invites someone Access must still let in.
 */
import { KantelError } from "@kantel/contracts";

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
	 * Unset: the Worker answers only behind Access, as before.
	 */
	readonly KANTEL_PUBLIC_URL?: string;
	/** The address sign-in codes and invites are sent from, through the `SIGN_IN_MAIL` binding. */
	readonly KANTEL_SIGN_IN_FROM?: string;
	/** How many sign-in codes and invites the Worker sends a day (UTC), at most. Default `DEFAULT_DAILY_MAIL_CAP`. */
	readonly KANTEL_SIGN_IN_DAILY_CAP?: string;
}

/**
 * Mail a day, at most: 100 a day stays inside the 3,000 a month Workers Paid includes for Email Sending, so open sign-up
 * can't run up a bill however it is used.
 */
export const DEFAULT_DAILY_MAIL_CAP = 100;

/**
 * Kantel's hosted ports domain (decided 3 Nov 2026). It is under kantel.dev, a registrable domain apart from the
 * console's (harbour.myslop.app), so a sandbox's page can't set cookies the console reads. It isn't on the Public
 * Suffix List yet (deferred until hosted ports are served and used), so until it is, a port's page can set cookies for
 * all of kantel.dev: port names are one site to browsers, cookies aren't private between sandboxes, and a console
 * moved under kantel.dev would receive them too. A deployment of this Worker on another domain sets
 * KANTEL_COMPUTE_PORTS_DOMAIN to its own.
 */
export const HOSTED_PORTS_DOMAIN = "ports.kantel.dev";

export interface GatewayConfig {
	/** Cloudflare Access, when people may sign in. Without it only API keys authenticate. */
	readonly access?: { readonly teamDomain: string; readonly audience: string };
	/** The person invited as the organisation's first admin. */
	readonly adminEmail?: string;
	/** The first admin's name; only used when the bootstrap invites them. */
	readonly adminName?: string;
	/** The domain port URLs are under, from KANTEL_COMPUTE_PORTS_DOMAIN. Absent, `HOSTED_PORTS_DOMAIN`. */
	readonly portsDomain?: string;
	/**
	 * Email-code sign-in and open sign-up on the public origin. Absent unless KANTEL_PUBLIC_URL and KANTEL_SIGN_IN_FROM
	 * are both set; it then also needs the `SIGN_IN_MAIL` binding to send anything.
	 */
	readonly emailSignIn?: {
		/** The public origin, such as `https://app.kantel.dev`. */
		readonly publicUrl: string;
		readonly from: string;
		readonly dailyCap: number;
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
	const portsDomain = trimmed(vars.KANTEL_COMPUTE_PORTS_DOMAIN)
		.toLowerCase()
		.replace(/^\*?\.+|\.+$/g, "");
	if (portsDomain !== "" && !DNS_NAME.test(portsDomain)) {
		throw new KantelError("invalid", "KANTEL_COMPUTE_PORTS_DOMAIN is a DNS name such as ports.example.com");
	}
	const emailSignIn = emailSignInConfig(vars);
	return {
		...(emailSignIn === undefined ? {} : { emailSignIn }),
		...(portsDomain === "" ? {} : { portsDomain }),
		...(teamDomain === "" ? {} : { access: { teamDomain, audience } }),
		...(adminEmail === "" ? {} : { adminEmail }),
		...(adminName === "" ? {} : { adminName }),
	};
}

/**
 * KANTEL_PUBLIC_URL, KANTEL_SIGN_IN_FROM and KANTEL_SIGN_IN_DAILY_CAP. Both of the first two or neither: one without the
 * other is refused rather than served with sign-in silently off.
 */
function emailSignInConfig(vars: GatewayVars): GatewayConfig["emailSignIn"] {
	const publicUrl = trimmed(vars.KANTEL_PUBLIC_URL);
	const from = trimmed(vars.KANTEL_SIGN_IN_FROM);
	if (publicUrl === "" && from === "") return undefined;
	if (publicUrl === "" || from === "") {
		throw new KantelError("invalid", "Set both KANTEL_PUBLIC_URL and KANTEL_SIGN_IN_FROM, or neither");
	}
	if (!/^https?:\/\/[^/?#\s]+\/?$/i.test(publicUrl)) {
		throw new KantelError("invalid", "KANTEL_PUBLIC_URL is an origin such as https://app.kantel.dev");
	}
	if (!/^[^\s@]+@[^\s@]+$/.test(from)) throw new KantelError("invalid", "KANTEL_SIGN_IN_FROM must be an email address");
	const capText = trimmed(vars.KANTEL_SIGN_IN_DAILY_CAP);
	const dailyCap = capText === "" ? DEFAULT_DAILY_MAIL_CAP : Number(capText);
	if (!(Number.isInteger(dailyCap) && dailyCap >= 0)) {
		throw new KantelError("invalid", "KANTEL_SIGN_IN_DAILY_CAP must be a whole number");
	}
	return { publicUrl: new URL(publicUrl).origin, from, dailyCap };
}
