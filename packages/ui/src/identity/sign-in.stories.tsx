import { KantelError } from "@kantel/contracts";
import { useState } from "react";
import { MINUTE } from "../primitives/format.ts";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { SignInScreen } from "./sign-in.tsx";
import {
	type ProviderSignInProblem,
	SIGN_IN_CODE_TTL_MS,
	type SignInApi,
	type SignInProviderLink,
	type SignInState,
} from "./sign-in-model.ts";
import { LiveSignIn } from "./stories-live.tsx";
import { signInFrame } from "./story-frames.ts";

export default { title: "Identity/Sign in" } satisfies StoryDefault;

/** The workbench's code; any other is wrong. */
const STORY_CODE = "123456";
const EMAIL = "ada@kantel.test";

/** A stand-in for the OTP routes: a short pause as a real call takes, then the answer the server would give. */
const storyApi: SignInApi = {
	start: () => new Promise((resolve) => setTimeout(resolve, 500)),
	verify: (_email, code) =>
		new Promise((resolve, reject) =>
			setTimeout(
				() =>
					code === STORY_CODE
						? resolve()
						: reject(new KantelError("forbidden", "The code is not valid", { authentication: "invalid" })),
				500,
			),
		),
};

/** A code step asked for `minutesAgo` minutes ago. */
function codeStep(minutesAgo: number, rest: Partial<Extract<SignInState, { step: "code" }>> = {}): SignInState {
	const sentAt = Date.now() - minutesAgo * MINUTE;
	return {
		step: "code",
		email: EMAIL,
		code: "",
		sentAt,
		expiresAt: sentAt + SIGN_IN_CODE_TTL_MS,
		tries: 0,
		busy: false,
		resent: false,
		...rest,
	};
}

/** GitHub and Google, as the hosted service offers them. Their links go nowhere in the workbench. */
const PROVIDERS: readonly SignInProviderLink[] = [
	{ provider: "github", href: "#github" },
	{ provider: "google", href: "#google" },
];

/** The screen as a page, starting in `state`; it carries on from there against the stand-in API. */
function Screen({
	state,
	providers,
	providerProblem,
	emailCode,
}: {
	state: () => SignInState;
	providers?: readonly SignInProviderLink[];
	providerProblem?: ProviderSignInProblem;
	emailCode?: boolean;
}) {
	const [initial] = useState(state);
	return (
		<div className={signInFrame}>
			<SignInScreen
				api={storyApi}
				initial={initial}
				{...(providers === undefined ? {} : { providers })}
				{...(providerProblem === undefined ? {} : { providerProblem })}
				{...(emailCode === undefined ? {} : { emailCode })}
			/>
		</div>
	);
}

const start = (): SignInState => ({ step: "email", email: "", busy: false });

export const Default: Story = () => <Screen state={() => ({ step: "email", email: "", busy: false })} />;
Default.storyName = "Start";

export const Sending: Story = () => <Screen state={() => ({ step: "email", email: EMAIL, busy: true })} />;

export const CodeSent: Story = () => <Screen state={() => codeStep(0)} />;
CodeSent.storyName = "Code sent";

export const WrongCode: Story = () => (
	<Screen state={() => codeStep(2, { code: "123465", tries: 1, problem: { kind: "wrong-code", triesLeft: 4 } })} />
);
WrongCode.storyName = "Wrong code";

export const ShortCode: Story = () => (
	<Screen state={() => codeStep(1, { code: "1234", problem: { kind: "short-code" } })} />
);
ShortCode.storyName = "Short code";

export const Expired: Story = () => (
	<Screen state={() => codeStep(11, { code: "123456", problem: { kind: "expired" } })} />
);

export const UsedUp: Story = () => (
	<Screen state={() => codeStep(4, { code: "654321", tries: 5, problem: { kind: "used-up" } })} />
);
UsedUp.storyName = "Used up";

export const RateLimited: Story = () => (
	<Screen
		state={() => ({
			step: "email",
			email: EMAIL,
			busy: false,
			problem: { kind: "rate-limited", until: Date.now() + 14 * MINUTE },
		})}
	/>
);
RateLimited.storyName = "Rate limited";

export const RateLimitedNewCode: Story = () => (
	<Screen
		state={() => codeStep(3, { resent: true, problem: { kind: "rate-limited", until: Date.now() + 38 * MINUTE } })}
	/>
);
RateLimitedNewCode.storyName = "Rate limited on a new code";

export const Resent: Story = () => <Screen state={() => codeStep(0, { resent: true })} />;
Resent.storyName = "New code sent";

// Named ErrorState so the export doesn't shadow the global Error; the workbench shows it as "Error".
export const ErrorState: Story = () => (
	<Screen state={() => ({ step: "email", email: EMAIL, busy: false, problem: { kind: "unavailable" } })} />
);
ErrorState.storyName = "Error";

export const InvalidEmail: Story = () => (
	<Screen
		state={() => ({
			step: "email",
			email: "ada at kantel",
			busy: false,
			problem: { kind: "invalid-email", message: "Enter your email address." },
		})}
	/>
);
InvalidEmail.storyName = "Invalid email";

export const LongContent: Story = () => (
	<Screen
		state={() =>
			codeStep(1, {
				email: "ada.augusta.king-noel.countess-of-lovelace@analytical-engine.kantel.example.org",
			})
		}
	/>
);
LongContent.storyName = "Long content";

export const SignedIn: Story = () => <Screen state={() => ({ step: "signed-in", email: EMAIL })} />;
SignedIn.storyName = "Signed in";

export const Mobile: Story = () => <Screen state={() => codeStep(1, { code: "12" })} />;
Mobile.meta = { width: 420 };

/** GitHub and Google above the email form, as on app.kantel.dev once their clients are set. */
export const WithProviders: Story = () => <Screen state={start} providers={PROVIDERS} />;
WithProviders.storyName = "With GitHub and Google";

export const WithProvidersMobile: Story = () => <Screen state={start} providers={PROVIDERS} />;
WithProvidersMobile.storyName = "With GitHub and Google, mobile";
WithProvidersMobile.meta = { width: 420 };

/** Only GitHub set up: one button. */
export const WithGitHubOnly: Story = () => (
	<Screen state={start} providers={[{ provider: "github", href: "#github" }]} />
);
WithGitHubOnly.storyName = "With GitHub only";

/** No mail to send codes with (self-hosted without SMTP): the providers alone. */
export const ProvidersOnly: Story = () => <Screen state={start} providers={PROVIDERS} emailCode={false} />;
ProvidersOnly.storyName = "Providers only";

export const ProviderCancelled: Story = () => (
	<Screen state={start} providers={PROVIDERS} providerProblem={{ error: "cancelled", provider: "google" }} />
);
ProviderCancelled.storyName = "Provider: cancelled";

export const ProviderUnverifiedEmail: Story = () => (
	<Screen state={start} providers={PROVIDERS} providerProblem={{ error: "unverified_email", provider: "github" }} />
);
ProviderUnverifiedEmail.storyName = "Provider: unverified email";

export const ProviderStateMismatch: Story = () => (
	<Screen state={start} providers={PROVIDERS} providerProblem={{ error: "state_mismatch", provider: "github" }} />
);
ProviderStateMismatch.storyName = "Provider: state mismatch";

export const ProviderNotAllowed: Story = () => (
	<Screen state={start} providers={PROVIDERS} providerProblem={{ error: "not_allowed", provider: "google" }} />
);
ProviderNotAllowed.storyName = "Provider: not invited";

export const ProviderFailed: Story = () => (
	<Screen state={start} providers={PROVIDERS} providerProblem={{ error: "failed", provider: "google" }} />
);
ProviderFailed.storyName = "Provider: failed";

/**
 * The screen against the real OTP handler (`@kantel/identity/otp/http`) over an in-memory directory and mailer, in
 * the page. Codes go to the inbox beside it; only ada@kantel.test is invited.
 */
export const Live: Story = () => <LiveSignIn />;
