import type { MemorySpace } from "@kantel/contracts";
import { Button, EmptyState, MemoryPage, Notice, Skeleton, SkillsPage } from "@kantel/ui";
import { useCallback, useEffect, useState } from "react";
import type { ProjectSummary } from "../api/client.ts";
import type { ConsoleAgent, ConsoleSharing } from "../api/oversight.ts";
import { SHELL_EMPTY } from "../ui/shell-styles.ts";
import { memoryPath, navigate, skillsPath } from "./router.ts";

// The agent's skills and memory in the console: @kantel/ui's pages over the console's agent seam. The open skill or
// concept is in the path, so a link opens it; picking another replaces the entry rather than piling up history.

/** The skills page: the skills a session sees, by scope, each one's revisions and files. */
export function SkillsScreen({
	agent,
	projects,
	skillId,
	sharing,
}: {
	agent: ConsoleAgent;
	projects: readonly ProjectSummary[];
	skillId?: string;
	/** Shows a project's skill's sharing on its page. */
	sharing?: ConsoleSharing;
}) {
	const onSelect = useCallback((id: string | undefined) => navigate(skillsPath(id), { replace: true }), []);
	const shown = agent.projects ?? projects;
	return (
		<SkillsPage
			source={agent.skills}
			visibility={agent.viewer === undefined ? {} : { userId: agent.viewer }}
			projects={[
				{ value: "", label: "The organisation" },
				...shown.map((project) => ({ value: project.id, label: project.name })),
			]}
			directory={{ project: (id) => shown.find((project) => project.id === id)?.name }}
			{...(skillId === undefined ? {} : { initialSelected: skillId })}
			onSelect={onSelect}
			{...(agent.author === undefined ? {} : { author: agent.author, owners: agent.owners ?? [] })}
			{...(sharing === undefined
				? {}
				: {
						sharing: {
							source: sharing.source,
							directory: {
								...sharing.directory,
								project: (id: string) =>
									sharing.directory.project?.(id) ??
									sharing.projects.find((project) => project.id === id)?.name ??
									shown.find((project) => project.id === id)?.name,
							},
						},
					})}
		/>
	);
}

type Spaces =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly spaces: readonly MemorySpace[] }
	| { readonly status: "error" };

/** The memory page: the spaces the person may read, their concepts by scope, search and recall. */
export function MemoryScreen({
	agent,
	projects,
	conceptId,
}: {
	agent: ConsoleAgent;
	projects: readonly ProjectSummary[];
	conceptId?: string;
}) {
	const [state, setState] = useState<Spaces>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the read on "Try again".
	useEffect(() => {
		let live = true;
		setState({ status: "loading" });
		agent.spaces().then(
			(spaces) => live && setState({ status: "ready", spaces }),
			() => live && setState({ status: "error" }),
		);
		return () => {
			live = false;
		};
	}, [agent, attempt]);
	const onSelect = useCallback((id: string | undefined) => navigate(memoryPath(id), { replace: true }), []);

	if (state.status === "loading") {
		return (
			<div className="agent-loading">
				<span className="kt-sr-only">Loading memory</span>
				<Skeleton lines={3} />
				<Skeleton lines={3} />
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div className={SHELL_EMPTY}>
				<Notice
					level="error"
					action={
						<Button size="xs" onClick={() => setAttempt((count) => count + 1)}>
							Try again
						</Button>
					}
				>
					Couldn't read the memory spaces. Try again.
				</Notice>
			</div>
		);
	}
	if (state.spaces.length === 0) {
		return (
			<div className={SHELL_EMPTY}>
				<h1 className="kt-sr-only">Memory</h1>
				<EmptyState title="No memory here yet">
					A host loads a memory space with a snapshot import; its concepts show here once it has.
				</EmptyState>
			</div>
		);
	}
	return (
		<MemoryPage
			source={agent.memory}
			spaces={state.spaces}
			{...(agent.profile === undefined ? {} : { profile: agent.profile })}
			directory={{ project: (id) => (agent.projects ?? projects).find((project) => project.id === id)?.name }}
			{...(conceptId === undefined ? {} : { initialSelected: conceptId })}
			onSelect={onSelect}
		/>
	);
}
