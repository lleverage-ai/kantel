import type { QuestionCard as QuestionCardData } from "@kantel/protocol";
import { type FormEvent, type KeyboardEvent, memo, useId, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { TextField } from "../primitives/controls.tsx";
import { CheckCircleIcon, MinusCircleIcon, QuestionIcon } from "../primitives/icons.tsx";
import { Panel } from "../primitives/surface.tsx";

// The question and browser cards (this file and browser-grant-card.tsx), styled with Tailwind utilities
// (src/tokens/tailwind.css): a Panel while open, one quiet line once settled. The kt- class names stay as hooks:
// composer.css pads `.kt-composer-banner > .kt-card-quiet`.

/** A settled card: one line, the size of a tool row. */
export const cardQuiet =
	"kt-card-quiet m-0 flex min-h-control-xs min-w-0 items-center gap-2 text-sm leading-tight text-muted";
/** The settled line's words, cut short with an ellipsis. */
export const cardQuietText = "kt-card-quiet-text min-w-0 truncate";
/** The open card: a Panel the width of the column. */
export const cardPanel = "kt-card w-full";
/** The icon and the words beside it. */
export const cardHead = "kt-card-head flex min-w-0 items-start gap-2";
/** The head's icon, centred on the first line of the question. */
export const cardHeadIcon = "mt-[calc((var(--kt-text-md)*var(--kt-leading)_-_var(--kt-icon-md))/2)]";
/** The question over its detail. */
export const cardText = "kt-card-text flex min-w-0 flex-col gap-0.5";
export const cardQuestion = "kt-card-question m-0 min-w-0 text-md leading-normal font-medium text-fg wrap-anywhere";
export const cardDetail = "kt-card-detail m-0 min-w-0 text-sm leading-normal text-muted wrap-anywhere";
/** The card's buttons, at its end. */
export const cardActions = "kt-card-actions flex flex-wrap justify-end gap-2";
/**
 * A button in the actions: on a phone the buttons share the row. `!`: the Button's own `flex-none` utility sets the
 * same property, and two utilities for one property resolve by Tailwind's order, not the class list's.
 */
export const cardAction = "max-sm:flex-1!";

/** The options: whole rows are the click target, the radio is real, the number says which digit picks it. */
const optionList = "kt-question-options flex min-w-0 flex-col gap-0.5";
/** Read-only options (no onAnswer): a numbered list, not radios. */
const staticList = "kt-question-options-static m-0 list-none p-0";
/** An option's row; on a touch screen a touch target tall, its parts centred. Its background is set where it's used. */
const optionRow =
	"kt-question-option flex min-h-control-sm min-w-0 cursor-pointer items-start gap-2 rounded-control px-2 py-1 text-sm leading-normal text-fg transition-[background-color] duration-(--kt-duration-fast) pointer-coarse:min-h-control-lg pointer-coarse:items-center";
/** The radio, centred on the option's first line (on its row's centre on a touch screen). */
const radio =
	"kt-question-radio kt-focusable mx-0 mt-[calc((var(--kt-text-sm)*var(--kt-leading)_-_var(--kt-icon-sm))/2)] mb-0 size-icon-sm flex-none cursor-pointer accent-accent pointer-coarse:mt-0";
const optionNumber = "kt-question-number min-w-[1ch] flex-none text-faint tabular-nums";
const optionText = "kt-question-option-text min-w-0 flex-1 wrap-anywhere";

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
			<p className={cardQuiet} title={card.text}>
				<CheckCircleIcon size="sm" className="kt-card-icon-done text-status-done" />
				<span className={cardQuietText}>
					{card.answer === undefined || card.answer === "" ? (
						"You answered"
					) : (
						<>
							You answered: <span className="kt-card-quiet-value text-fg">{card.answer}</span>
						</>
					)}
				</span>
			</p>
		);
	}
	if (card.status === "withdrawn") {
		return (
			<p className={cardQuiet} title={card.text}>
				<MinusCircleIcon size="sm" className="kt-card-icon-quiet text-faint" />
				<span className={cardQuietText}>The agent withdrew this question</span>
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
		<Panel className={`${cardPanel} kt-question-card`} aria-labelledby={questionId}>
			<div className={cardHead}>
				<QuestionIcon className={`kt-card-icon-waiting text-status-waiting ${cardHeadIcon}`} />
				<div className={cardText}>
					<p id={questionId} className={cardQuestion}>
						{card.text}
					</p>
					<p className={cardDetail}>Waiting for an answer</p>
				</div>
			</div>
			{options.length === 0 ? null : (
				<ol className={`${optionList} ${staticList}`} aria-label="Options">
					{options.map((option, index) => (
						<li key={option} className={`${optionRow} hover:bg-hover`}>
							<span className={optionNumber} aria-hidden="true">
								{index + 1}
							</span>
							<span className={optionText}>{option}</span>
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
		<Panel className={`${cardPanel} kt-question-card`} aria-labelledby={questionId} onKeyDown={keyDown}>
			<form className="kt-card-form m-0 flex min-w-0 flex-col gap-3" onSubmit={submit}>
				<div className={cardHead}>
					<QuestionIcon className={`kt-card-icon-waiting text-status-waiting ${cardHeadIcon}`} />
					<p id={questionId} className={cardQuestion}>
						{card.text}
					</p>
				</div>
				{options.length === 0 ? null : (
					<div className={optionList} role="radiogroup" aria-labelledby={questionId}>
						{options.map((option, index) => (
							// The chosen row is selected whether or not it is hovered.
							<label key={option} className={`${optionRow} ${choice === index ? "bg-selected" : "hover:bg-hover"}`}>
								<input
									ref={(element) => {
										radios.current[index] = element;
									}}
									type="radio"
									name={`${id}-option`}
									className={radio}
									value={option}
									checked={choice === index}
									onChange={() => setChoice(index)}
								/>
								<span className={optionNumber} aria-hidden="true">
									{index + 1}
								</span>
								<span className={optionText}>{option}</span>
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
				<div className={cardActions}>
					<Button type="submit" variant="primary" className={cardAction} disabled={!ready} busy={busy}>
						Answer
					</Button>
				</div>
			</form>
		</Panel>
	);
}
