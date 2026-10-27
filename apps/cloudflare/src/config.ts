/**
 * The gateway's configuration, read from the Worker's vars. Nothing here is secret: the Access team domain and AUD tag
 * are what every visitor's token already names, and the admin email only invites someone Access must still let in.
 */
import { HarbourError } from "@harbour/contracts";

export interface GatewayVars {
	readonly HARBOUR_ACCESS_TEAM_DOMAIN?: string;
	readonly HARBOUR_ACCESS_AUD?: string;
	readonly HARBOUR_ADMIN_EMAIL?: string;
}

export interface GatewayConfig {
	/** Cloudflare Access, when people may sign in. Without it only API keys authenticate. */
	readonly access?: { readonly teamDomain: string; readonly audience: string };
	/** The person invited as the organisation's first admin. */
	readonly adminEmail?: string;
}

const trimmed = (value: string | undefined): string => (value ?? "").trim();

/**
 * Reads the vars. The Access team domain and AUD come as a pair: one without the other is a broken deployment, and is
 * refused rather than served with sign-in silently off.
 */
export function gatewayConfig(vars: GatewayVars): GatewayConfig {
	const teamDomain = trimmed(vars.HARBOUR_ACCESS_TEAM_DOMAIN);
	const audience = trimmed(vars.HARBOUR_ACCESS_AUD);
	if ((teamDomain === "") !== (audience === "")) {
		throw new HarbourError("invalid", "Set both HARBOUR_ACCESS_TEAM_DOMAIN and HARBOUR_ACCESS_AUD, or neither");
	}
	const adminEmail = trimmed(vars.HARBOUR_ADMIN_EMAIL);
	if (adminEmail !== "" && !/^[^\s@]+@[^\s@]+$/.test(adminEmail)) {
		throw new HarbourError("invalid", "HARBOUR_ADMIN_EMAIL must be an email address");
	}
	return {
		...(teamDomain === "" ? {} : { access: { teamDomain, audience } }),
		...(adminEmail === "" ? {} : { adminEmail }),
	};
}
