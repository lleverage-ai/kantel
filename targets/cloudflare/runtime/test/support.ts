import type { DatabaseSync } from "node:sqlite";
import { staticTokenAuthenticator } from "@harbour/runtime/http";
import { SessionRuntimeDurableObjectCore, type SessionRuntimeDurableObjectCoreOptions } from "../src/index.ts";
import { durableObjectStorageOf } from "./support-sqlite.ts";

/**
 * A Durable Object's alarm, as the platform keeps it: one time or none. `fire` runs the core's handler as the
 * platform would, the alarm cleared first. `later` records every time an alarm was moved later than one still armed.
 */
export function fakeAlarm() {
	let armed: number | null = null;
	const set: number[] = [];
	const later: { readonly from: number; readonly to: number }[] = [];
	return {
		get armed() {
			return armed;
		},
		set,
		later,
		/** Leaves an alarm armed, as an earlier instance of the object would have. */
		arm(at: number) {
			armed = at;
		},
		async setAlarm(at: number) {
			if (armed !== null && at > armed) later.push({ from: armed, to: at });
			armed = at;
			set.push(at);
		},
		async getAlarm() {
			return armed;
		},
		async fire(core: SessionRuntimeDurableObjectCore) {
			armed = null;
			await core.alarm();
		},
	};
}

export type FakeAlarm = ReturnType<typeof fakeAlarm>;

/** A core over the database, as the object's class would build it, with the alarm faked. */
export function coreOn(
	db: DatabaseSync,
	models: SessionRuntimeDurableObjectCoreOptions["models"],
	alarm: FakeAlarm = fakeAlarm(),
	extra: Partial<SessionRuntimeDurableObjectCoreOptions> = {},
): SessionRuntimeDurableObjectCore {
	return new SessionRuntimeDurableObjectCore({
		...extra,
		...durableObjectStorageOf(db),
		setAlarm: alarm.setAlarm,
		getAlarm: alarm.getAlarm,
		authenticator: extra.authenticator ?? staticTokenAuthenticator({}),
		models,
	});
}
