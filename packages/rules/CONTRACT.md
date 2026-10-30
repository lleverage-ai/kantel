# Prompt rules

`PromptRules` (`@harbour/contracts/rules`) stores named prompt rules owned by the platform, an organisation, a project
or a user. A session gets them when it is created, around its profile's own layers:

**platform → organisation → project → profile → user**

Within each owner, rules go by `order` (lowest first) and then by name. An organisation session has no project layer.
The design is decision 5 of `docs/design/org-scope.md`.

## Behaviour

- `put` creates the owner's rule of that name, or replaces its text and order. The rule keeps its ID and `createdAt`.
  Names are 1 to 100 letters, digits, `.`, `_` and `-`, starting with a letter or digit. Text is 1 to 32,768
  characters and not blank. `order` is a whole number between -1,000,000 and 1,000,000 (default 0). Anything else is
  `invalid`.
- `list(owner)` returns that owner's rules in order. `get` and `remove` take a rule ID.
- `forSession({ projectId?, userId? })` returns the platform's rules, the organisation's, then the project's when a
  project is named, then the user's when a user is named. `resolvePromptLayers(rules, profile.promptLayers)` turns them
  into the session's layers, each named `rules:<owner kind>:<name>`.
- The runtime (`SessionRuntimeOptions.rules`) resolves a session's rules once, at `create`, as Harbour itself. It keeps
  the joined layers with its copy of the profile, so a restart or a fork runs the same prompt. An edit reaches only new
  sessions.
- Harbour adds no rules of its own (#143). The platform layer stays empty until a `system` caller writes to it.

## Who may do what

| Owner | Write (`put`, `remove`) | Read (`list`, `get`, `forSession`) |
| --- | --- | --- |
| platform | `system` only (`requireSystem`) | every organisation |
| organisation | an organisation-wide admin | the organisation's members |
| project | an admin on the project, or an organisation-wide admin | viewer on the project |
| user | that user, or an organisation-wide admin | the organisation's members |

Agents never write rules, whatever the scope of their session. For an agent, every write check asks for admin, which no
agent holds, so the refusal is audited as `access.denied` in the same way as any other. An organisation session's agent
can read the organisation's rules but never a project's. Another organisation's rule or owner is `not_found`.

Every change is audited as `rules.rule.put` or `rules.rule.removed` (source `rules`). The event records the rule's ID
and its owner (kind, and the project or user), never its text.

## Implementations

- `createPromptRules({ store, access?, audit?, clock? })` (`@harbour/rules`) contains every check above, over a
  `PromptRuleStore` that only keeps rows. `save` upserts on (owner, name) atomically, so two writes racing on one name
  leave a single rule.
- `createMemoryPromptRules` (`@harbour/rules/memory`) is the reference implementation.
- `createSqlPromptRules({ driver })` and `migrateRules` (`@harbour/rules/sql`) store rules in one `prompt_rules` table
  on `@harbour/sql`. Cloudflare uses D1 and self-hosted uses Postgres.
- `createRulesApi` (`@harbour/rules/http`) serves `@harbour/api`'s `ruleRoutes`:

  | Route | Call |
  | --- | --- |
  | `GET /v1/rules?owner=&projectId=&userId=` | `list` (for `owner=user`, the user defaults to the calling person) |
  | `GET /v1/rules/resolved?projectId=&userId=` | `forSession`: what a new session would get |
  | `GET /v1/rules/{ruleId}` | `get` |
  | `PUT /v1/rules` | `put` |
  | `DELETE /v1/rules/{ruleId}` | `remove`, answering with the removed rule |

## Conformance

`registerRulesConformance` (`@harbour/testing/rules`) runs against memory, PGlite (Postgres), node:sqlite and D1
(Miniflare). Its cases cover:

- order and replacement;
- audit without text;
- validation;
- platform rules;
- user rules;
- `not_found` across organisations;
- `forSession` order, including no project layer for an organisation session;
- writes by owner;
- agents refused;
- reads by owner.

`packages/runtime/test/rules.test.ts` checks the runtime's layering: platform, organisation, project, profile and user
in a project session; no project layer in an organisation session; and rules fixed at creation.
