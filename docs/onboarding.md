# First-run onboarding, headless

The console's first-run onboarding (`/welcome`) connects a model, adds connectors and starts a first session. It is a
client of public API routes and nothing else: every step below works with an API key alone, through `curl` or the SDK
(`@harbour/api/sdk`). Harbour has no CLI of its own yet, so `curl` is the command-line equivalent.

- Onboarding state: `packages/contracts/src/onboarding.ts`, behaviour in
  [packages/onboarding/CONTRACT.md](../packages/onboarding/CONTRACT.md).
- Model providers: `packages/contracts/src/model-providers.ts`, served by `@harbour/models/providers-http`.
- Connectors: the [Connections API](connections.md).
- Sessions: `POST /v1/sessions` and `POST /v1/sessions/{sessionId}/messages`, as the console's New session uses.

Reads are open to anyone in the organisation, agents included, so a packaged agent can see whether setup is done.
Changes need an organisation-wide admin; agents never may.

## Where onboarding is

```sh
curl "$HARBOUR/v1/onboarding" -H "authorization: Bearer $KEY"
# → { "organisationId": "org_…", "status": "active", "current": "models",
#     "steps": { "models": "pending", "connectors": "pending", "session": "pending" } }
```

`status` is `active`, `completed` (no step pending) or `dismissed`. The console's root opens `/welcome` for an admin
while it is `active`.

| Step | Console | API | SDK |
| --- | --- | --- | --- |
| Settle a step | Continue / Skip this step | `PUT /v1/onboarding/steps/{step}` `{ "status": "done" \| "skipped" \| "pending" }` | `setOnboardingStep(step, { status })` |
| Go to a step | The stepper | `PUT /v1/onboarding/current` `{ "step" }` | `setOnboardingCurrent({ step })` |
| Skip it all | Skip setup | `POST /v1/onboarding/dismiss` | `dismissOnboarding()` |
| Open it again | Setup in the sidebar | `POST /v1/onboarding/reopen` `{ "step"? }` | `reopenOnboarding({ step })` |

## Step 1: connect a model

```sh
curl "$HARBOUR/v1/model-providers" -H "authorization: Bearer $KEY"
# → { "items": [ { "id": "claude", "auth": "subscription", "available": true, "connection": … }, … ],
#     "defaultRoute": { "connectorId": "…", "modelId": "…", "owner": "platform" | "organisation" } }
```

`defaultRoute` is what sessions run on now; without it nothing serves them. A provider with `available: false` says
why in `unavailableReason`.

**An API key** (Anthropic, OpenAI, OpenRouter, Vercel AI Gateway, any OpenAI-compatible server). The key goes into the
vault and is never answered, logged or audited. The organisation gets a connector and routes, and `default` if it had
none (or with `makeDefault`).

```sh
curl -X PUT "$HARBOUR/v1/model-providers/anthropic/key" -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"key":"sk-ant-…","model":"claude-sonnet-5-5"}'
# openai-compatible also needs "baseUrl": "https://models.example.com/v1"
```

SDK: `connectModelProviderKey(providerId, { key, baseUrl?, model?, makeDefault? })`. The key's shape is checked, not
probed against the provider.

**A subscription** (Claude Pro/Max, ChatGPT Plus/Pro) signs in through the deployment's CLIProxyAPI. It is offered only
where `HARBOUR_CPA_MANAGEMENT_KEY` is set, since CLIProxyAPI's credentials serve the whole deployment.

```sh
# 1. Start: answers a sign-in page.
curl -X POST "$HARBOUR/v1/model-providers/claude/sign-ins" -H "authorization: Bearer $KEY"
# → { "id": "…", "providerId": "claude", "status": "pending", "url": "https://claude.ai/oauth/authorize?…" }
# 2. Open url in a browser and sign in.
# 3. Poll until it settles.
curl "$HARBOUR/v1/model-providers/claude/sign-ins/<id>" -H "authorization: Bearer $KEY"
# → { "status": "completed" }  (or "failed", with "error")
# Signing in on another machine: the provider's redirect to localhost won't load. Hand back the address it ended on.
curl -X POST "$HARBOUR/v1/model-providers/claude/sign-ins/<id>/finish" -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"redirectUrl":"http://localhost:54545/callback?code=…&state=…"}'
```

SDK: `startModelSignIn`, `getModelSignIn`, `finishModelSignIn`. `DELETE /v1/model-providers/{providerId}`
(`disconnectModelProvider`) removes a key provider's connector and routes.

## Step 2: add connectors

The Connections API, as in [connections.md](connections.md): `GET /v1/connections/catalogue`, then
`POST /v1/connections/connect` with `{ templateId, owner }` and poll `GET /v1/connections/connect/{attemptId}`, or
`POST /v1/connections/keys` with `{ templateId, owner, value }` for a template that takes a key. The console connects
them for the signed-in person (`owner: { kind: "user", … }`).

## Step 3: start a first session

```sh
curl -X POST "$HARBOUR/v1/sessions" -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"projectId":"prj_…","agentId":"…","title":"First session"}'
# → { "id": "ses_…", … }
curl -X POST "$HARBOUR/v1/sessions/ses_…/messages" -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"Tell me what you can do here, and what you would need from me to do more."}'
curl -X PUT "$HARBOUR/v1/onboarding/steps/session" -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"status":"done"}'
```

SDK: `createSession({ projectId, agentId, title })`, `sendMessage(sessionId, { text })`, then
`setOnboardingStep("session", { status: "done" })`.

## Limits

- Subscriptions use CLIProxyAPI's `/v0/management` API (`*-auth-url`, `get-auth-status`, `oauth-callback`,
  `auth-files`), which CLIProxyAPI marks as nearing deprecation. Its successor's documentation wasn't published when
  this was written.
- On Cloudflare the model gateway reaches only CLIProxyAPI, so key providers are listed as unavailable there.
- Disconnecting a key provider leaves its vault item, with no route to it: the vault has no delete yet.
- The deployment's CLIProxyAPI `default` route counts as serving sessions even before any account is signed in to it;
  the console says so when it can tell (subscriptions available, none signed in).
