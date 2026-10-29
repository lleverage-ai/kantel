import type { Recall } from "@harbour/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CopyButton, Disclosure, TextField } from "../primitives/controls.tsx";
import { SearchIcon } from "../primitives/icons.tsx";
import { ListRow } from "../primitives/list-row.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice, Panel } from "../primitives/surface.tsx";
import { type MemoryPageSource, manifestDetail, RECALL_REASON, recallScopes } from "./memory-model.ts";

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
		<div className="hb-memory-recall">
			<form className="hb-memory-recall-form" onSubmit={submit} aria-label="Recall">
				<TextField
					label="Message"
					hint="What a session would be asked. Recall searches by it, as a host does before each turn."
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<div className="hb-memory-recall-scopes">
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
				</div>
				<div>
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
				</div>
			</form>

			{state.phase === "idle" ? (
				<EmptyState title="See what a session would recall">
					Write a message and recall: the profile, the matches and the exceptions, with why each came.
				</EmptyState>
			) : state.phase === "running" ? (
				<div className="hb-memory-loading" aria-busy="true">
					<span className="hb-sr-only">Recalling</span>
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
		<div className="hb-memory-recall-result">
			<Panel
				header={
					<div className="hb-memory-section-row">
						<h3 className="hb-memory-section">Recalled</h3>
						<span className="hb-memory-count">
							{recall.manifest.length} {recall.manifest.length === 1 ? "concept" : "concepts"}
							{recall.truncated ? ", more matched than the limits allow" : ""}
						</span>
					</div>
				}
			>
				<ol className="hb-memory-rows">
					{recall.manifest.map((entry) => {
						const reason = RECALL_REASON[entry.reason];
						const detail = manifestDetail(entry);
						return (
							<li key={`${entry.spaceId}:${entry.conceptId}:${entry.reason}`}>
								<ListRow
									density="comfortable"
									overline={<span className="hb-mono">{entry.conceptId}</span>}
									title={titles.get(entry.conceptId) ?? entry.conceptId}
									{...(detail === undefined ? {} : { meta: detail })}
									trailing={
										<span className="hb-memory-badges">
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
					<ul className="hb-memory-skipped">
						{recall.skipped.map((item) => (
							<li key={item.conceptId}>
								<span className="hb-mono">{item.conceptId}</span>
								<span className="hb-memory-skipped-reason">{item.reason}</span>
							</li>
						))}
					</ul>
				</Disclosure>
			)}
			<Disclosure summary="As the prompt carries it">
				<div className="hb-memory-recall-text">
					<div className="hb-memory-recall-copy">
						<CopyButton text={recall.text} label="Copy recall text" size="sm" />
					</div>
					<pre className="hb-memory-code hb-selectable">{recall.text}</pre>
				</div>
			</Disclosure>
		</div>
	);
}
