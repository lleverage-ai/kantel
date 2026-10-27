import type { QuestionCard as QuestionCardData } from "@harbour/protocol";
import { type FormEvent, type KeyboardEvent, memo, useId, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { TextField } from "../primitives/controls.tsx";
import { CheckCircleIcon, MinusCircleIcon, QuestionIcon } from "../primitives/icons.tsx";
import { Panel } from "../primitives/surface.tsx";
import "./cards.css";

export type QuestionCardProps = {
	card: QuestionCardData;
	/**
	 * Called with the chosen option or the typed answer, trimmed. Without it an open question is shown read-only: the
	 * question and its options, waiting for an answer, with nothing to press (a replay, an audit view).
	 */
	onAnswer?: (answer: string) => void;
	/** The answer is on its way: the Answer button shows a spinner. */
	busy?: boolean;
};

/** True when the key press is going into a field that takes text, where a digit is just a digit. */
function typingInto(target: EventTarget): boolean {
	if (target instanceof HTMLTextAreaElement) return true;
	if (target instanceof HTMLInputElement) return target.type !== "radio" && target.type !== "checkbox";
	return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * A question from the agent, answered in place. Open: the question, its options as numbered radios (digits 1 to 9
 * pick one while focus is in the card), an "Other" field and Answer. Answered and withdrawn fold to one quiet line.
 * Fits in the composer's banner slot, as T3 Code attaches questions above the composer.
 */
export const QuestionCard = memo(function QuestionCard({ card, onAnswer, busy = false }: QuestionCardProps) {
	if (card.status === "answered") {
		return (
			<p className="hb-card-quiet" title={card.text}>
				<CheckCircleIcon size="sm" className="hb-card-icon-done" />
				<span className="hb-card-quiet-text">
					{card.answer === undefined || card.answer === "" ? (
						"You answered"
					) : (
						<>
							You answered: <span className="hb-card-quiet-value">{card.answer}</span>
						</>
					)}
				</span>
			</p>
		);
	}
	if (card.status === "withdrawn") {
		return (
			<p className="hb-card-quiet" title={card.text}>
				<MinusCircleIcon size="sm" className="hb-card-icon-quiet" />
				<span className="hb-card-quiet-text">The agent withdrew this question</span>
			</p>
		);
	}
	if (onAnswer === undefined) return <PendingQuestion card={card} />;
	return <OpenQuestion card={card} onAnswer={onAnswer} busy={busy} />;
});

/** An open question nobody can answer from here: what was asked and the options offered, nothing to press. */
function PendingQuestion({ card }: { card: QuestionCardData }) {
	const questionId = useId();
	const options = card.options ?? [];
	return (
		<Panel className="hb-card hb-question-card" aria-labelledby={questionId}>
			<div className="hb-card-head">
				<QuestionIcon className="hb-card-icon-waiting" />
				<div className="hb-card-text">
					<p id={questionId} className="hb-card-question">
						{card.text}
					</p>
					<p className="hb-card-detail">Waiting for an answer</p>
				</div>
			</div>
			{options.length === 0 ? null : (
				<ol className="hb-question-options hb-question-options-static" aria-label="Options">
					{options.map((option, index) => (
						<li key={option} className="hb-question-option">
							<span className="hb-question-number" aria-hidden="true">
								{index + 1}
							</span>
							<span className="hb-question-option-text">{option}</span>
						</li>
					))}
				</ol>
			)}
		</Panel>
	);
}

function OpenQuestion({
	card,
	onAnswer,
	busy,
}: {
	card: QuestionCardData;
	onAnswer: (answer: string) => void;
	busy: boolean;
}) {
	const options = card.options ?? [];
	const [choice, setChoice] = useState<number | undefined>(undefined);
	const [other, setOther] = useState("");
	const radios = useRef<(HTMLInputElement | null)[]>([]);
	const id = useId();
	const questionId = `${id}-question`;

	// Whichever was touched last wins: picking an option sends it, typing in Other clears the option.
	const picked = choice === undefined ? undefined : options[choice];
	const answer = picked ?? other.trim();
	const ready = answer !== "";

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!ready || busy) return;
		onAnswer(answer);
	};

	const keyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.altKey || event.ctrlKey || event.metaKey || typingInto(event.target)) return;
		if (!/^[1-9]$/.test(event.key)) return;
		const index = Number(event.key) - 1;
		if (index >= options.length) return;
		event.preventDefault();
		setChoice(index);
		radios.current[index]?.focus();
	};

	return (
		<Panel className="hb-card hb-question-card" aria-labelledby={questionId} onKeyDown={keyDown}>
			<form className="hb-card-form" onSubmit={submit}>
				<div className="hb-card-head">
					<QuestionIcon className="hb-card-icon-waiting" />
					<p id={questionId} className="hb-card-question">
						{card.text}
					</p>
				</div>
				{options.length === 0 ? null : (
					<div className="hb-question-options" role="radiogroup" aria-labelledby={questionId}>
						{options.map((option, index) => (
							<label key={option} className="hb-question-option">
								<input
									ref={(element) => {
										radios.current[index] = element;
									}}
									type="radio"
									name={`${id}-option`}
									className="hb-question-radio hb-focusable"
									value={option}
									checked={choice === index}
									onChange={() => setChoice(index)}
								/>
								<span className="hb-question-number" aria-hidden="true">
									{index + 1}
								</span>
								<span className="hb-question-option-text">{option}</span>
							</label>
						))}
					</div>
				)}
				<TextField
					label={options.length === 0 ? "Your answer" : "Other"}
					value={other}
					onChange={(event) => {
						setOther(event.target.value);
						if (event.target.value !== "") setChoice(undefined);
					}}
					autoComplete="off"
				/>
				<div className="hb-card-actions">
					<Button type="submit" variant="primary" disabled={!ready} busy={busy}>
						Answer
					</Button>
				</div>
			</form>
		</Panel>
	);
}
