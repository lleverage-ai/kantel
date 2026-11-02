# Product shots

Every shot on kantel.dev is the real console UI, at 2x, never a mock-up. Each comes from one of two places in this
repository, both with fixture data only (no real accounts, keys or people's data).

| Shot | Where it comes from |
| --- | --- |
| `console.png` | The console in recorded mode (`pnpm --filter @kantel/console dev:recorded`), session `s-flaky` at 1440×900 |
| `session.png` | Recorded mode, session `s-script` |
| `question.png` | Recorded mode, session `s-digest` |
| `approval.png` | Recorded mode, session `s-linear-key` |
| `connections.png` | Recorded mode, `/connections` |
| `browser.png` | `@kantel/ui`'s workbench, story `session--browser-window--window`, the first browser window |
| `codemode.png` | Workbench story `session--connection-calls--in-a-script`, the opened script card |
| `vault.png` | Workbench story `vault--vault-page--pending` |
| `onboarding.png`, `onboarding-connectors.png` | Workbench stories `onboarding--onboarding-page--models-a-subscription-signed-in` and `…--connectors-the-catalogue` from the onboarding pull request (#395), rendered in the Kantel theme |

When shooting, recorded mode's own notes ("These are recorded sessions", "This is a recorded session, so it can't be
steered", "Sign-in stubbed") are hidden, and fixture text that still says Harbour or Partan reads Kantel, as it will
once the rename reaches the fixtures. Nothing else is changed.

Retake them when the console changes visibly. Astro (`astro:assets`) makes the AVIF and WebP sizes the page serves.
