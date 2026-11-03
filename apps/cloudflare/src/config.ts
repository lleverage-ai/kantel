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
	 * Kantel Connect (experimental): `experimental` lets accounts enrol machines of their own, which dial out to this
	 * Worker and run only that account's sandboxes. Unset, empty or `off`: off, and nothing about the Worker changes.
	 */
	readonly KANTEL_CONNECT?: string;
	/** With KANTEL_CONNECT: the origin hosts and clients reach this Worker at, such as `https://kantel.example.com`. */
	readonly KANTEL_PUBLIC_URL?: string;
}

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
	/** Kantel Connect, when on: where hosts reach this Worker. */
	readonly connect?: { readonly publicUrl: string };
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
	const connect = connectConfig(vars);
	return {
		...(portsDomain === "" ? {} : { portsDomain }),
		...(teamDomain === "" ? {} : { access: { teamDomain, audience } }),
		...(adminEmail === "" ? {} : { adminEmail }),
		...(adminName === "" ? {} : { adminName }),
		...(connect === undefined ? {} : { connect }),
	};
}

/**
 * KANTEL_CONNECT and KANTEL_PUBLIC_URL. Off unless the switch says `experimental`; on, it needs the origin hosts dial,
 * and a typo in either is refused rather than leaving Connect silently off.
 */
function connectConfig(vars: GatewayVars): GatewayConfig["connect"] {
	const value = trimmed(vars.KANTEL_CONNECT).toLowerCase();
	if (value === "" || value === "off") return undefined;
	if (value !== "experimental") throw new KantelError("invalid", "KANTEL_CONNECT must be `experimental` or `off`");
	const publicUrl = trimmed(vars.KANTEL_PUBLIC_URL);
	if (!/^https?:\/\/[^/]+\/?$/.test(publicUrl)) {
		throw new KantelError(
			"invalid",
			"KANTEL_CONNECT needs KANTEL_PUBLIC_URL: the origin hosts reach this Worker at, such as https://kantel.example.com",
		);
	}
	return { publicUrl: new URL(publicUrl).origin };
}
