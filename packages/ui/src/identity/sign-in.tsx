import { type FormEvent, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { KantelLockup } from "../brand/kantel.tsx";
import { Button, buttonClass, buttonLabelClass } from "../primitives/button.tsx";
import { TextField } from "../primitives/controls.tsx";
import { clockTime } from "../primitives/format.ts";
import { Spinner } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";
import { PROVIDER_NAMES, ProviderMark } from "./provider-marks.tsx";
import {
	codeIsDead,
	createSignInFlow,
	type ProviderSignInProblem,
	SIGN_IN_CODE_DIGITS,
	type SignInApi,
	type SignInFlow,
	type SignInProblem,
	type SignInProviderLink,
	type SignInState,
} from "./sign-in-model.ts";

// Styled with Tailwind utilities (src/tokens/tailwind.css). One narrow column, centred on the canvas, with no panel
// around it: T3 Code keeps its sign-in to a heading, a field and one button, and so does this. The column is 360px at
// 1280px, and the page's own width, less its padding, at 420px.

/** In the theme's display face, as the brand sets its headings. */
const title = "m-0 font-display text-title font-regular leading-tight text-fg";
/** Under the title, pulled up so it reads as the title's second line. */
const lede = "m-0 -mt-1.5 text-sm leading-normal text-muted wrap-anywhere";
const address = "font-medium text-fg";
/** The field and its button, full width. */
const form = "flex flex-col gap-3 [&>.kt-button]:w-full";
/**
 * The code: larger and monospace, so six digits read as one code and a mistyped one is easy to see. `!` so these
 * replace the input's own height, font and colour utilities (primitives/controls.tsx) outright.
 */
const codeField =
	"[&_.kt-input]:h-control-lg! [&_.kt-input]:font-mono! [&_.kt-input]:text-lg! [&_.kt-input]:tabular-nums [&_.kt-input:disabled]:text-disabled!";

export interface SignInScreenProps {
	/** `POST /auth/otp/start` and `/auth/otp/verify`; the identity client's `startOtp` and `verifyOtp` fit. */
	readonly api: SignInApi;
	/** Called once the code signs the person in; the host then loads the console. */
	readonly onSignedIn?: (email: string) => void;
	/** Where the flow starts: the email step, unless a story or test says otherwise. */
	readonly initial?: SignInState;
	/** The clock the flow reads. Default `Date.now`. */
	readonly now?: () => number;
	/** The product's name in the heading and the messages. Default "Kantel". */
	readonly product?: string;
	/** What stands over the heading. Default: Kantel's endorsed lockup, "Kantel, by Lleverage". */
	readonly brand?: ReactNode;
	/**
	 * The providers the deployment signs people in with (the 401's `signIn` names them), each a button above the email
	 * form that goes to its start link. Default none.
	 */
	readonly providers?: readonly SignInProviderLink[];
	/** Why the last sign-in with a provider failed, shown over the buttons. */
	readonly providerProblem?: ProviderSignInProblem;
	/** Whether the deployment signs people in with an email code. Default true; false shows only the providers. */
	readonly emailCode?: boolean;
}

const tries = (count: number) => (count === 1 ? "1 try" : `${count} tries`);

/** The sentence for a problem, or undefined for one the code field shows itself. */
function problemText(problem: SignInProblem | undefined, now: number, product: string): string | undefined {
	switch (problem?.kind) {
		case "expired":
			return "This code has expired. Send a new one to carry on.";
		case "used-up":
			return "That was the last try for this code. Send a new one to carry on.";
		case "rate-limited":
			return `You've asked for too many codes. You can ask for another at ${clockTime(problem.until, now)}.`;
		case "unavailable":
			return `${product} can't sign you in right now. Try again in a moment.`;
		default:
			return undefined;
	}
}

/** The sentence for a failed sign-in with a provider, and how loudly to say it. */
export function providerProblemText(
	problem: ProviderSignInProblem,
	product: string,
): { readonly level: "warning" | "error"; readonly text: string } {
	const name = problem.provider === undefined ? "the provider" : PROVIDER_NAMES[problem.provider];
	const Name = problem.provider === undefined ? "The provider" : PROVIDER_NAMES[problem.provider];
	switch (problem.error) {
		case "cancelled":
			return { level: "warning", text: `Signing in with ${name} was cancelled. Try again, or use another way below.` };
		case "unverified_email":
			return {
				level: "error",
				text:
					problem.provider === "github"
						? "Your GitHub account has no verified primary email. Verify it on GitHub, or sign in with an email code."
						: `${Name} hasn't verified the email on your account. Verify it there, or sign in with an email code.`,
			};
		case "state_mismatch":
			return {
				level: "error",
				text: "That sign-in didn't start in this browser, or it took too long. Start again from this page.",
			};
		case "not_allowed":
			return {
				level: "error",
				text: `Your ${name} email hasn't been invited to this ${product}. Ask an admin to invite it.`,
			};
		default:
			return { level: "error", text: `${product} couldn't finish signing you in with ${name}. Try again in a moment.` };
	}
}

/**
 * Kantel's own sign-in: GitHub and Google where the deployment has them, each a button that leaves for the provider,
 * then the email and the 6-digit code mailed to it. It fills the page, centred, and works the same at 420px. A host shows it when the
 * API answers 401 and names `email_otp` as the way to sign in.
 *
 * The server never says why a code failed or whether an email is known, so the screen says what it can work out:
 * a wrong code and the tries left, a code past its 10 minutes, a code burned by its fifth wrong try, and when another
 * code may be asked for. Timers run only while there is a deadline to reach (the code's expiry, the end of a rate
 * limit), and nothing ticks on screen.
 */
export function SignInScreen({
	api,
	onSignedIn,
	initial,
	now = Date.now,
	product = "Kantel",
	brand = <KantelLockup endorsed className="h-(--kt-brand-md)" title="Kantel, by Lleverage" />,
	providers = [],
	providerProblem,
	emailCode = true,
}: SignInScreenProps) {
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
				<div className="mb-4">{brand}</div>
				{state.step === "email" ? (
					<EmailStep
						flow={flow}
						state={state}
						product={product}
						now={now}
						providers={providers}
						emailCode={emailCode}
						{...(providerProblem === undefined ? {} : { providerProblem })}
					/>
				) : state.step === "code" ? (
					<CodeStep flow={flow} state={state} product={product} now={now} />
				) : (
					<SignedIn email={state.email} product={product} />
				)}
			</div>
		</div>
	);
}

/** A line either side of "or", between the providers' buttons and the email form. */
const divider =
	"flex items-center gap-3 text-xs text-faint before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border";

/** The providers' buttons: links to each one's start, which leave the page for the provider's consent screen. */
function ProviderButtons({ providers }: { providers: readonly SignInProviderLink[] }) {
	// The one followed, so its button shows a spinner while the browser leaves (a provider can take a moment).
	const [leaving, setLeaving] = useState<string>();
	return (
		<div className="flex flex-col gap-2">
			{providers.map(({ provider, href }) => (
				<a
					key={provider}
					href={href}
					className={`${buttonClass("secondary", "md")} w-full no-underline`}
					aria-busy={leaving === provider || undefined}
					onClick={() => setLeaving(provider)}
				>
					{leaving === provider ? <Spinner size="sm" /> : <ProviderMark provider={provider} />}
					<span className={buttonLabelClass}>Sign in with {PROVIDER_NAMES[provider]}</span>
				</a>
			))}
		</div>
	);
}

function EmailStep({
	flow,
	state,
	product,
	now,
	providers,
	providerProblem,
	emailCode,
}: {
	flow: SignInFlow;
	state: Extract<SignInState, { step: "email" }>;
	product: string;
	now: () => number;
	providers: readonly SignInProviderLink[];
	providerProblem?: ProviderSignInProblem;
	emailCode: boolean;
}) {
	const limited = state.problem?.kind === "rate-limited";
	const notice = problemText(state.problem, now(), product);
	const failed = providerProblem === undefined ? undefined : providerProblemText(providerProblem, product);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		void flow.requestCode();
	};
	const withProviders = providers.length > 0;
	return (
		<>
			<h1 className={title}>Sign in to {product}</h1>
			<p className={lede}>
				{!emailCode
					? "Choose how to sign in."
					: withProviders
						? `Continue with ${providers.map(({ provider }) => PROVIDER_NAMES[provider]).join(" or ")}, or get a ${SIGN_IN_CODE_DIGITS}-digit code by email.`
						: `Enter your email and we'll send you a ${SIGN_IN_CODE_DIGITS}-digit code.`}
			</p>
			{failed === undefined ? null : <Notice level={failed.level}>{failed.text}</Notice>}
			{withProviders ? <ProviderButtons providers={providers} /> : null}
			{withProviders && emailCode ? <div className={divider}>or</div> : null}
			{emailCode ? (
				<EmailForm flow={flow} state={state} limited={limited} submit={submit} autoFocus={!withProviders} />
			) : null}
			{notice === undefined ? null : <Notice level={limited ? "warning" : "error"}>{notice}</Notice>}
		</>
	);
}

function EmailForm({
	flow,
	state,
	limited,
	submit,
	autoFocus,
}: {
	flow: SignInFlow;
	state: Extract<SignInState, { step: "email" }>;
	limited: boolean;
	submit: (event: FormEvent) => void;
	autoFocus: boolean;
}) {
	return (
		<form className={form} onSubmit={submit} noValidate>
			<TextField
				label="Email"
				type="email"
				name="email"
				autoComplete="email"
				inputMode="email"
				spellCheck={false}
				// Alone, the field is the whole page and focusing it is what the person came for; under the providers' buttons it
				// waits, so a screen reader starts at the heading and the buttons come first.
				autoFocus={autoFocus}
				value={state.email}
				onChange={(event) => flow.setEmail(event.target.value)}
				{...(state.problem?.kind === "invalid-email" ? { error: state.problem.message } : {})}
			/>
			<Button variant="primary" size="md" type="submit" busy={state.busy} disabled={limited}>
				Email me a code
			</Button>
		</form>
	);
}

function CodeStep({
	flow,
	state,
	product,
	now,
}: {
	flow: SignInFlow;
	state: Extract<SignInState, { step: "code" }>;
	product: string;
	now: () => number;
}) {
	const field = useRef<HTMLInputElement>(null);
	const dead = codeIsDead(state.problem);
	const limited = state.problem?.kind === "rate-limited";
	const wrong = state.problem?.kind === "wrong-code" ? state.problem : undefined;
	const notice = problemText(state.problem, now(), product);

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
			<p className="kt-sr-only" aria-live="polite">
				{wrongText ?? ""}
			</p>
		</>
	);
}

function SignedIn({ email, product }: { email: string; product: string }) {
	return (
		<>
			<h1 className={title}>You're signed in</h1>
			<p className={lede} role="status">
				Signed in as <span className={address}>{email}</span>. Opening {product}.
			</p>
		</>
	);
}
