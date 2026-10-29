import type { Concept } from "@harbour/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { TextField } from "../primitives/controls.tsx";
import { Notice, Panel } from "../primitives/surface.tsx";
import {
	applyAsPerson,
	type CorrectionDraft,
	changeError,
	correctionProblems,
	correctionWrite,
	forgetWrite,
	type MemoryPageSource,
} from "./memory-model.ts";

export interface ConceptChangeProps {
	readonly mode: "correct" | "forget";
	readonly concept: Concept;
	readonly source: MemoryPageSource;
	readonly now: number;
	/** Called once the change is applied. */
	readonly onDone: () => void;
	/** Called when applying failed after the proposal was made, so the host can show it in Proposals. */
	readonly onProposed?: () => void;
	readonly onCancel: () => void;
}

/**
 * A person correcting or forgetting a concept. `Memory` changes concepts only through proposals, so this proposes
 * the change at the version on screen and applies it at once; it shows in the concept's history like any other. A
 * version that moved on meanwhile is refused and nothing changes.
 */
export function ConceptChange({ mode, concept, source, now, onDone, onProposed, onCancel }: ConceptChangeProps) {
	const [draft, setDraft] = useState<CorrectionDraft>({
		title: concept.title,
		statement: concept.statement,
		sources: concept.sources.join("\n"),
	});
	const [reason, setReason] = useState("");
	const [checked, setChecked] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const heading = useRef<HTMLHeadingElement>(null);
	const statementId = useId();
	const sourcesId = useId();
	useEffect(() => heading.current?.focus({ preventScroll: true }), []);

	const problems =
		mode === "correct"
			? correctionProblems(draft)
			: reason.trim() === ""
				? { reason: "Say why, for the history." }
				: {};
	const show = <K extends string>(key: K) => (checked ? (problems as Partial<Record<string, string>>)[key] : undefined);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setChecked(true);
		if (Object.keys(problems).length > 0) return;
		setBusy(true);
		setError(undefined);
		try {
			const write = mode === "correct" ? correctionWrite(concept, draft, now) : forgetWrite(concept, reason);
			const result = await applyAsPerson(source, concept.spaceId, write);
			if (result.applied) {
				onDone();
				return;
			}
			setError(changeError(result.error, "apply"));
			onProposed?.();
		} catch (caught) {
			setError(changeError(caught, "propose"));
		} finally {
			setBusy(false);
		}
	};

	const title = mode === "correct" ? "Correct it" : "Forget it";
	return (
		<form onSubmit={submit} aria-labelledby="hb-concept-change-title" noValidate>
			<Panel
				tone={mode === "forget" ? "error" : "default"}
				header={
					<h3
						id="hb-concept-change-title"
						className="hb-memory-section hb-concept-change-title"
						ref={heading}
						tabIndex={-1}
					>
						{title}
					</h3>
				}
				footer={
					<div className="hb-memory-proposal-actions">
						<Button type="submit" variant={mode === "forget" ? "danger" : "primary"} busy={busy}>
							{mode === "correct" ? "Save correction" : "Forget it"}
						</Button>
						<Button variant="ghost" disabled={busy} onClick={onCancel}>
							Cancel
						</Button>
					</div>
				}
			>
				<div className="hb-concept-change-fields">
					{mode === "correct" ? (
						<>
							<TextField
								label="Title"
								value={draft.title}
								{...(show("title") === undefined ? {} : { error: show("title")! })}
								onChange={(event) => setDraft({ ...draft, title: event.target.value })}
							/>
							<TextArea
								id={statementId}
								label="Statement"
								hint="The fact itself, short. Sessions recall this."
								value={draft.statement}
								error={show("statement")}
								rows={4}
								onChange={(statement) => setDraft({ ...draft, statement })}
							/>
							<TextArea
								id={sourcesId}
								label="Sources"
								hint="One per line: a link, owner/repo@commit:path:lines or a ticket ID."
								value={draft.sources}
								error={show("sources")}
								rows={3}
								mono
								onChange={(sources) => setDraft({ ...draft, sources })}
							/>
							<p className="hb-memory-note">
								Saves version {concept.version + 1}.{" "}
								{concept.setBy === "learned" ? "It becomes yours: agents can no longer change it." : ""}
							</p>
						</>
					) : (
						<>
							<p className="hb-memory-note">
								Recall stops showing it. It stays here, with its history, under Forgotten.
							</p>
							<TextField
								label="Why"
								value={reason}
								{...(show("reason") === undefined ? {} : { error: show("reason")! })}
								onChange={(event) => setReason(event.target.value)}
							/>
						</>
					)}
				</div>
				{error === undefined ? null : <Notice level="error">{error}</Notice>}
			</Panel>
		</form>
	);
}

/** A labelled multi-line field in the text field's frame. */
function TextArea({
	id,
	label,
	hint,
	error,
	value,
	rows,
	mono = false,
	onChange,
}: {
	id: string;
	label: string;
	hint: string;
	error: string | undefined;
	value: string;
	rows: number;
	mono?: boolean;
	onChange: (value: string) => void;
}) {
	return (
		<div className="hb-text-field">
			<label className="hb-text-field-label" htmlFor={id}>
				{label}
			</label>
			<textarea
				id={id}
				className={`hb-input hb-concept-change-text hb-focusable${mono ? " hb-concept-change-mono" : ""}`}
				rows={rows}
				value={value}
				aria-invalid={error !== undefined || undefined}
				aria-describedby={`${id}-note`}
				onChange={(event) => onChange(event.target.value)}
			/>
			<p id={`${id}-note`} className={error === undefined ? "hb-text-field-hint" : "hb-text-field-error"}>
				{error ?? hint}
			</p>
		</div>
	);
}
