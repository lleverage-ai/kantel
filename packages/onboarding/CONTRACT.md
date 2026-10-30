# Onboarding

`OnboardingService` (`@harbour/contracts/onboarding`) records where an organisation is in first-run onboarding: connect
a model, add connectors, start a first session. It only records progress. What a step does is made through that
resource's own API, and Harbour adds no prompt or setting of its own here.

## Behaviour

- There is one state per organisation. Before anything is stored, `get` answers `freshOnboarding`: `active` at
  `models`, with every step `pending` and no `updatedAt`.
- `setStep(step, done | skipped)` settles the step. `current` moves to the next pending step after it, else the first
  pending one before it, else it stays on the step. When no step is pending, the onboarding is `completed`; otherwise
  it is `active`.
- `setStep(step, pending)` makes the step `current` and the onboarding `active`.
- `goTo(step)` makes the step `current` and the onboarding `active`, without changing any step's status.
- `dismiss` makes the onboarding `dismissed`. `current` and each step's status are unchanged.
- `reopen(step?)` makes the onboarding `active` at `step`, or at `models`, keeping each step's status.
- Every change sets `updatedAt` from the clock. An unknown step or status is `invalid`.

## Who may do what

| Call | Who |
| --- | --- |
| `get` | anyone in the organisation, agents included |
| `setStep`, `goTo`, `dismiss`, `reopen` | `system`, or an organisation-wide admin (`access.require` with `needed: "admin"` and no project) |

Agents never change onboarding. With `access`, their refusal is the access check's, audited as `access.denied` with
the operation `onboarding.setStep`, `onboarding.goTo`, `onboarding.dismiss` or `onboarding.reopen`. Without `access`,
only agents are refused.

Every change is audited as `onboarding.changed` (source `onboarding`). The subject is `{ kind: "onboarding", id:
<organisationId> }`. The data holds `operation`, the `step` acted on (not for `dismiss`), the onboarding's new
`status`, and, for `setStep`, the step's new status as `stepStatus`.

## Implementations

- `createOnboarding({ store, access?, audit?, clock? })` (`@harbour/onboarding`) contains every rule above. It runs
  over an `OnboardingStore`, which only gets and saves one state per organisation.
- `createMemoryOnboarding` (`@harbour/onboarding/memory`) is the reference implementation.
- `createSqlOnboarding({ driver })` and `migrateOnboarding` (`@harbour/onboarding/sql`) store one row per organisation
  in an `onboarding` table on `@harbour/sql`. Cloudflare uses D1 and self-hosted uses Postgres.
- `createOnboardingApi` (`@harbour/onboarding/http`) serves `@harbour/api`'s `onboardingRoutes`:

  | Route | Call |
  | --- | --- |
  | `GET /v1/onboarding` | `get` |
  | `PUT /v1/onboarding/steps/{step}` with `{ status }` | `setStep` |
  | `PUT /v1/onboarding/current` with `{ step }` | `goTo` |
  | `POST /v1/onboarding/dismiss` | `dismiss` |
  | `POST /v1/onboarding/reopen` with `{ step? }` | `reopen` |

## Conformance

`registerOnboardingConformance` (`@harbour/testing/onboarding`) runs against memory, PGlite (Postgres), node:sqlite
and D1 (Miniflare). Its cases cover:

- the fresh state;
- settling steps through to completed;
- going back to an earlier pending step;
- `goTo`, `dismiss` and `reopen` keeping each step's status;
- validation;
- the audit event;
- one state per organisation;
- refusing anyone without an organisation-wide admin role;
- refusing agents while letting them read.
