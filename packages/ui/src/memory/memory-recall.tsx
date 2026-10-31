import type { Recall } from "@kantel/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CopyButton, Disclosure, TextField } from "../primitives/controls.tsx";
import { FormActions, FormGrid, FormLayout } from "../primitives/form-layout.tsx";
import { SearchIcon } from "../primitives/icons.tsx";
import { ListRow } from "../primitives/list-row.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice, Panel } from "../primitives/surface.tsx";
import { type MemoryPageSource, manifestDetail, RECALL_REASON, recallScopes } from "./memory-model.ts";
import { memoryBadges, memoryFaint, memoryLoading, memoryRows, memorySection } from "./memory-styles.ts";

/** The view, and the result under the form: blocks a step apart. */
const column = "flex min-w-0 flex-col gap-4";

export interface MemoryRecallProps {
	readonly source: MemoryPageSource;
	readonly spaceIds: readonly string[];
	/** Concept IDs recalled whatever the query, as a host's sessions are given them. */
	readonly profile?: readonly string[];
	/** Run this recall when the view opens, for stories and links. */
	readonly initialQuery?: string;
	readonly initialProjects?: string;
	readonly initialJobs?: string;
	readonly onOpen?: (conceptId: string) => void;
}

type RecallState =
	| { readonly phase: "idle" }
	| { readonly phase: "running" }
	| { readonly phase: "failed" }
	| { readonly phase: "done"; readonly query: string; readonly recall: Recall };

/**
 * What a session would be shown for a message: the recall a host runs before a turn, with its manifest. Each recalled
 * concept says why it came (the profile, a match with its score and terms, or a job's exception riding with the rule it
 * overrides), and whether it is stale or was cut short. The rendered text, as the prompt carries it, is a click away.
 */
export function MemoryRecall({
	source,
	spaceIds,
	profile,
	initialQuery = "",
	initialProjects = "",
	initialJobs = "",
	onOpen,
}: MemoryRecallProps) {
	const [query, setQuery] = useState(initialQuery);
	const [projects, setProjects] = useState(initialProjects);
	const [jobs, setJobs] = useState(initialJobs);
	const [state, setState] = useState<RecallState>({ phase: "idle" });
	const live = useRef(true);
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
		};
	}, []);

	const run = async (text: string) => {
		setState({ phase: "running" });
		try {
			const scopes = recallScopes(projects, jobs);
			const recall = await source.recall({
				spaceIds,
				query: text,
				...(scopes === undefined ? {} : { scopes }),
				...(profile === undefined ? {} : { profile }),
			});
			if (live.current) setState({ phase: "done", query: text, recall });
		} catch {
			if (live.current) setState({ phase: "failed" });
		}
	};
	// The initial recall runs once, when the view opens; later ones run on submit.
	const first = useRef(initialQuery);
	useEffect(() => {
		if (first.current !== "") void run(first.current);
		first.current = "";
	});
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (query.trim() !== "") void run(query.trim());
	};

	return (
		<div className={column}>
			<form className="max-w-content" onSubmit={submit} aria-label="Recall">
				<FormLayout>
					<TextField
						label="Message"
						hint="What a session would be asked. Recall searches by it, as a host does before each turn."
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<FormGrid columns={2}>
						<TextField
							label="Projects"
							hint="Project scopes that apply, comma separated"
							value={projects}
							onChange={(event) => setProjects(event.target.value)}
						/>
						<TextField
							label="Jobs"
							hint="Job scopes, for their exceptions"
							value={jobs}
							onChange={(event) => setJobs(event.target.value)}
						/>
					</FormGrid>
					<FormActions>
						<Button
							type="submit"
							variant="primary"
							size="sm"
							icon={<SearchIcon size="sm" />}
							busy={state.phase === "running"}
							disabled={query.trim() === ""}
						>
							Recall
						</Button>
					</FormActions>
				</FormLayout>
			</form>

			{state.phase === "idle" ? (
				<EmptyState title="See what a session would recall">
					Write a message and recall: the profile, the matches and the exceptions, with why each came.
				</EmptyState>
			) : state.phase === "running" ? (
				<div className={memoryLoading} aria-busy="true">
					<span className="kt-sr-only">Recalling</span>
					<Skeleton lines={2} />
					<Skeleton lines={2} />
				</div>
			) : state.phase === "failed" ? (
				<Notice level="error">Couldn't recall from this space. Try again.</Notice>
			) : (
				<RecallResult recall={state.recall} {...(onOpen === undefined ? {} : { onOpen })} />
			)}
		</div>
	);
}

function RecallResult({ recall, onOpen }: { recall: Recall; onOpen?: (conceptId: string) => void }) {
	if (recall.manifest.length === 0) {
		return (
			<EmptyState title="Nothing recalled">
				No concept matched, and the profile is empty. A session would get no memory for this message.
			</EmptyState>
		);
	}
	const titles = new Map(recall.concepts.map((concept) => [concept.id, concept.title]));
	return (
		<div className={column}>
			<Panel
				header={
					<div className="flex flex-1 flex-wrap items-baseline justify-between gap-x-2 gap-y-1.5">
						<h3 className={memorySection}>Recalled</h3>
						<span className={memoryFaint}>
							{recall.manifest.length} {recall.manifest.length === 1 ? "concept" : "concepts"}
							{recall.truncated ? ", more matched than the limits allow" : ""}
						</span>
					</div>
				}
			>
				<ol className={memoryRows}>
					{recall.manifest.map((entry) => {
						const reason = RECALL_REASON[entry.reason];
						const detail = manifestDetail(entry);
						return (
							<li key={`${entry.spaceId}:${entry.conceptId}:${entry.reason}`}>
								<ListRow
									density="comfortable"
									overline={<span className="kt-mono">{entry.conceptId}</span>}
									title={titles.get(entry.conceptId) ?? entry.conceptId}
									{...(detail === undefined ? {} : { meta: detail })}
									trailing={
										<span className={memoryBadges}>
											{entry.stale ? <Badge tone="waiting">Stale</Badge> : null}
											<Badge tone={reason.tone}>{reason.label}</Badge>
										</span>
									}
									{...(onOpen === undefined ? {} : { onSelect: () => onOpen(entry.conceptId) })}
								/>
							</li>
						);
					})}
				</ol>
			</Panel>
			{recall.profileOmitted.length === 0 ? null : (
				<Notice level="warning" announce={false}>
					Left out of the profile for its limits: {recall.profileOmitted.join(", ")}. The prompt names them.
				</Notice>
			)}
			{recall.skipped.length === 0 ? null : (
				<Disclosure summary={`Matched but left out (${recall.skipped.length})`}>
					<ul className={memoryRows}>
						{recall.skipped.map((item) => (
							// Inset as the rows' text is.
							<li key={item.conceptId} className="flex flex-wrap gap-x-2 gap-y-1 px-2.5 py-0.5">
								<span className="kt-mono">{item.conceptId}</span>
								<span className={memoryFaint}>{item.reason}</span>
							</li>
						))}
					</ul>
				</Disclosure>
			)}
			<Disclosure summary="As the prompt carries it">
				<div className="flex flex-col gap-1.5">
					<div className="flex justify-end">
						<CopyButton text={recall.text} label="Copy recall text" size="sm" />
					</div>
					<pre className="kt-selectable m-0 max-h-96 overflow-auto rounded-panel border border-border bg-code-surface px-3 py-2.5 font-mono text-code leading-normal whitespace-pre-wrap wrap-anywhere">
						{recall.text}
					</pre>
				</div>
			</Disclosure>
		</div>
	);
}
