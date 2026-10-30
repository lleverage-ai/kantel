import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../primitives/button.tsx";
import { TextField } from "../primitives/controls.tsx";
import { clockTime } from "../primitives/format.ts";
import { Notice } from "../primitives/surface.tsx";
import {
	codeIsDead,
	createSignInFlow,
	SIGN_IN_CODE_DIGITS,
	type SignInApi,
	type SignInFlow,
	type SignInProblem,
	type SignInState,
} from "./sign-in-model.ts";

// Styled with Tailwind utilities (src/tokens/tailwind.css). One narrow column, centred on the canvas, with no panel
// around it: T3 Code keeps its sign-in to a heading, a field and one button, and so does this. The column is 360px at
// 1280px, and the page's own width, less its padding, at 420px.

const title = "m-0 text-lg font-strong leading-tight text-fg";
/** Under the title, pulled up so it reads as the title's second line. */
const lede = "m-0 -mt-1.5 text-sm leading-normal text-muted wrap-anywhere";
const address = "font-medium text-fg";
/** The field and its button, full width. */
const form = "flex flex-col gap-3 [&>.hb-button]:w-full";
/**
 * The code: larger and monospace, so six digits read as one code and a mistyped one is easy to see. `!` because the
 * input's own rules (primitives/controls.css) are unlayered and would beat a utility; drop it once TextField is on
 * utilities.
 */
const codeField =
	"[&_.hb-input]:h-control-lg! [&_.hb-input]:font-mono! [&_.hb-input]:text-lg! [&_.hb-input]:tabular-nums [&_.hb-input:disabled]:text-disabled!";

export interface SignInScreenProps {
	/** `POST /auth/otp/start` and `/auth/otp/verify`; the identity client's `startOtp` and `verifyOtp` fit. */
	readonly api: SignInApi;
	/** Called once the code signs the person in; the host then loads the console. */
	readonly onSignedIn?: (email: string) => void;
	/** Where the flow starts: the email step, unless a story or test says otherwise. */
	readonly initial?: SignInState;
	/** The clock the flow reads. Default `Date.now`. */
	readonly now?: () => number;
	/** The product's name in the heading. Default "Harbour". */
	readonly product?: string;
}

const tries = (count: number) => (count === 1 ? "1 try" : `${count} tries`);

/** The sentence for a problem, or undefined for one the code field shows itself. */
function problemText(problem: SignInProblem | undefined, now: number): string | undefined {
	switch (problem?.kind) {
		case "expired":
			return "This code has expired. Send a new one to carry on.";
		case "used-up":
			return "That was the last try for this code. Send a new one to carry on.";
		case "rate-limited":
			return `You've asked for too many codes. You can ask for another at ${clockTime(problem.until, now)}.`;
		case "unavailable":
			return "Harbour can't sign you in right now. Try again in a moment.";
		default:
			return undefined;
	}
}

/**
 * Harbour's own sign-in, for a deployment that signs people in with an email code (self-hosted): the email, then
 * the 6-digit code mailed to it. It fills the page, centred, and works the same at 420px. A host shows it when the
 * API answers 401 and names `email_otp` as the way to sign in.
 *
 * The server never says why a code failed or whether an email is known, so the screen says what it can work out:
 * a wrong code and the tries left, a code past its 10 minutes, a code burned by its fifth wrong try, and when another
 * code may be asked for. Timers run only while there is a deadline to reach (the code's expiry, the end of a rate
 * limit), and nothing ticks on screen.
 */
export function SignInScreen({ api, onSignedIn, initial, now = Date.now, product = "Harbour" }: SignInScreenProps) {
	const latest = useRef({ api, onSignedIn });
	latest.current = { api, onSignedIn };
	const [flow] = useState<SignInFlow>(() =>
		createSignInFlow({
			api: {
				start: (email) => latest.current.api.start(email),
				verify: (email, code) => latest.current.api.verify(email, code),
			},
			now,
			...(initial === undefined ? {} : { initial }),
			onSignedIn: (email) => latest.current.onSignedIn?.(email),
		}),
	);
	const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);

	// One timer, to the next deadline: the code's expiry or the end of a rate limit.
	const deadline =
		state.step === "signed-in"
			? undefined
			: state.problem?.kind === "rate-limited"
				? state.problem.until
				: state.step === "code" && state.problem === undefined
					? state.expiresAt
					: undefined;
	useEffect(() => {
		if (deadline === undefined) return;
		const timer = setTimeout(() => flow.tick(), Math.max(0, deadline - now()) + 50);
		return () => clearTimeout(timer);
	}, [deadline, flow, now]);

	return (
		<div className="grid min-h-full w-full place-items-center px-4 py-12 max-sm:items-start max-sm:py-8">
			{/* Sits a little above the middle, where the eye starts. */}
			<div className="flex w-full max-w-90 flex-col gap-3 mb-18 max-sm:mb-0">
				<p className="m-0 mb-2 text-md font-strong text-fg">{product}</p>
				{state.step === "email" ? (
					<EmailStep flow={flow} state={state} product={product} now={now} />
				) : state.step === "code" ? (
					<CodeStep flow={flow} state={state} now={now} />
				) : (
					<SignedIn email={state.email} />
				)}
			</div>
		</div>
	);
}

function EmailStep({
	flow,
	state,
	product,
	now,
}: {
	flow: SignInFlow;
	state: Extract<SignInState, { step: "email" }>;
	product: string;
	now: () => number;
}) {
	const limited = state.problem?.kind === "rate-limited";
	const notice = problemText(state.problem, now());
	const submit = (event: FormEvent) => {
		event.preventDefault();
		void flow.requestCode();
	};
	return (
		<>
			<h1 className={title}>Sign in to {product}</h1>
			<p className={lede}>Enter your email and we'll send you a {SIGN_IN_CODE_DIGITS}-digit code.</p>
			<form className={form} onSubmit={submit} noValidate>
				<TextField
					label="Email"
					type="email"
					name="email"
					autoComplete="email"
					inputMode="email"
					spellCheck={false}
					// The field is the whole page; focusing it is what the person came for.
					autoFocus
					value={state.email}
					onChange={(event) => flow.setEmail(event.target.value)}
					{...(state.problem?.kind === "invalid-email" ? { error: state.problem.message } : {})}
				/>
				<Button variant="primary" size="md" type="submit" busy={state.busy} disabled={limited}>
					Email me a code
				</Button>
			</form>
			{notice === undefined ? null : <Notice level={limited ? "warning" : "error"}>{notice}</Notice>}
		</>
	);
}

function CodeStep({
	flow,
	state,
	now,
}: {
	flow: SignInFlow;
	state: Extract<SignInState, { step: "code" }>;
	now: () => number;
}) {
	const field = useRef<HTMLInputElement>(null);
	const dead = codeIsDead(state.problem);
	const limited = state.problem?.kind === "rate-limited";
	const wrong = state.problem?.kind === "wrong-code" ? state.problem : undefined;
	const notice = problemText(state.problem, now());

	// After a wrong code, the field is selected, so typing the right one replaces it.
	useEffect(() => {
		if (wrong !== undefined) field.current?.select();
	}, [wrong]);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		void (dead ? flow.requestCode() : flow.verify());
	};
	const wrongText =
		state.problem?.kind === "short-code"
			? `Enter all ${SIGN_IN_CODE_DIGITS} digits of the code.`
			: wrong === undefined
				? undefined
				: `That code isn't right. You have ${tries(wrong.triesLeft)} left.`;

	return (
		<>
			<h1 className={title}>Check your email</h1>
			<p className={lede}>
				{state.resent ? "We sent a new code to " : "We sent a code to "}
				<span className={address}>{state.email}</span>.
				{dead ? null : ` It works until ${clockTime(state.expiresAt, now())}.`}
			</p>
			<form className={form} onSubmit={submit} noValidate>
				<TextField
					ref={field}
					label="Code"
					name="code"
					className={codeField}
					inputMode="numeric"
					autoComplete="one-time-code"
					spellCheck={false}
					// The person has just asked for the code; this is where it goes.
					autoFocus
					disabled={dead}
					value={state.code}
					onChange={(event) => {
						flow.setCode(event.target.value);
						// Six digits typed or pasted is a whole code: check it straight away.
						const after = flow.getState();
						if (after.step === "code" && after.code.length === SIGN_IN_CODE_DIGITS && after.code !== state.code) {
							void flow.verify();
						}
					}}
					{...(wrongText !== undefined
						? { error: wrongText }
						: dead
							? {}
							: { hint: "The code is in the email we just sent." })}
				/>
				{dead ? (
					<Button variant="primary" size="md" type="submit" busy={state.busy === "resend"} disabled={limited}>
						Send a new code
					</Button>
				) : (
					<Button variant="primary" size="md" type="submit" busy={state.busy === "verify"}>
						Sign in
					</Button>
				)}
			</form>
			{notice === undefined ? null : (
				<Notice level={state.problem?.kind === "unavailable" ? "error" : "warning"}>{notice}</Notice>
			)}
			<div className="-mx-2.5 -mt-1.5 flex flex-wrap justify-between gap-2">
				{dead ? null : (
					<Button
						variant="ghost"
						size="sm"
						busy={state.busy === "resend"}
						disabled={limited || state.busy === "verify"}
						onClick={() => void flow.requestCode()}
					>
						Send a new code
					</Button>
				)}
				<Button variant="ghost" size="sm" disabled={state.busy !== false} onClick={() => flow.changeEmail()}>
					Use a different email
				</Button>
			</div>
			<p className="hb-sr-only" aria-live="polite">
				{wrongText ?? ""}
			</p>
		</>
	);
}

function SignedIn({ email }: { email: string }) {
	return (
		<>
			<h1 className={title}>You're signed in</h1>
			<p className={lede} role="status">
				Signed in as <span className={address}>{email}</span>. Opening Harbour.
			</p>
		</>
	);
}
