/**
 * One queue of workspace commits per workspace, in this process. A code mode script's `Promise.all` over dozens of
 * `write` or `bash` calls commits to one workspace at once; each read the head, built its change and committed, so all
 * but one found the head moved, and with several writers moving it, some ran out of attempts (`base version N is not
 * the head`). Taking turns, a commit only retries for a writer outside this process (another stack object, a
 * container), which the retry loops around it still handle.
 */
const tails = new Map<string, Promise<void>>();

/** Runs `task` once every earlier task queued for `workspaceId` here has settled, and settles as it does. */
export function queueWorkspaceCommit<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
	const before = tails.get(workspaceId) ?? Promise.resolve();
	const run = before.then(task);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	tails.set(workspaceId, tail);
	// The last one out removes the entry, so the map holds only workspaces with commits in flight.
	void tail.then(() => {
		if (tails.get(workspaceId) === tail) tails.delete(workspaceId);
	});
	return run;
}
