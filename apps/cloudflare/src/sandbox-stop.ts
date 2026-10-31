/**
 * Stopping a closed session's sandbox container (`KantelSandbox.closeSession`, `src/sandbox-object.ts`), so its
 * instance is free for another session at once.
 *
 * - **`running` is only the object's own view.** Workers sets it when the object starts the container (or finds one
 *   running when the object starts), and clears it when its monitor call settles, whether the container exited or the
 *   call itself failed (workerd `src/workerd/api/container.c++`, `Container::Monitor::observe`). So it can read false
 *   while Cloudflare still runs the container: in a burst of closes (deployed, 16 sessions, TASK-3922), 2 objects saw
 *   no running container and stopped nothing, and both instances ran until their 10-minute inactivity stop.
 * - **`destroy()` does nothing then**: it returns at once when `running` is false, without asking Cloudflare. Nor do
 *   `signal()` or Cloudflare's own `Container` class (`@cloudflare/containers`), which also go by `running`.
 * - **The inactivity timeout does**: `setInactivityTimeout` goes to Cloudflare whatever `running` says, and it is what
 *   stopped those two containers in the end. A container the object can't see, but Cloudflare still has (`inspect()`),
 *   gets a short one, so it stops a moment after the close rather than 10 minutes after. Neither call starts a
 *   container: one asks, the other sets a timer.
 *
 * Nothing here throws: the close carries on, and at worst the container waits for its usual inactivity stop.
 */

/** The part of the Durable Object's `ctx.container` a stop uses. */
export interface StoppableContainer {
	readonly running: boolean;
	destroy(): Promise<void>;
	setInactivityTimeout(durationMs: number): Promise<void>;
	/** Cloudflare's own record of the container (`null`: none started, so nothing to stop). */
	inspect?(): Promise<unknown>;
}

/**
 * - `destroyed`: the object saw it running and destroyed it.
 * - `inactivity`: the object saw none running, but Cloudflare had one (or couldn't say): it stops once the object has
 *   been idle `releaseMs`.
 * - `none`: no container to stop (Cloudflare had none either, or nothing could be asked of it).
 */
export type ContainerStop = "destroyed" | "inactivity" | "none";

export interface StopOptions {
	/** The inactivity timeout given to a container the object can't see; more than 0. */
	readonly releaseMs: number;
}

/** Stops the container now if the object sees it, or on a short inactivity timeout if Cloudflare may still run it. */
export async function stopContainer(container: StoppableContainer, options: StopOptions): Promise<ContainerStop> {
	if (container.running) {
		try {
			await container.destroy();
			return "destroyed";
		} catch {
			// A failed destroy falls back to the short timeout, below.
		}
	} else if ((await runtimeHas(container)) === false) {
		// The usual case for a session whose container stopped long ago, idle: nothing to ask of Cloudflare.
		return "none";
	}
	try {
		await container.setInactivityTimeout(options.releaseMs);
		return "inactivity";
	} catch {
		return "none";
	}
}

/** Whether Cloudflare has a container started for the object; `undefined` when it can't say. */
async function runtimeHas(container: StoppableContainer): Promise<boolean | undefined> {
	if (typeof container.inspect !== "function") return undefined;
	try {
		return (await container.inspect()) !== null;
	} catch {
		return undefined;
	}
}
