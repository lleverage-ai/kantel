# Partan marketing copy: first draft

Status: first draft for the team to refine, 30 October 2026. Copy and section structure only. Each section gives a
heading, the copy, and a one-line note on the visual it needs. The visuals wait for the mark and logo, and for more of
the product to land, so screenshots are accurate.

Name: **Partan**, with **by Lleverage** in lockups (logo, page title, footer, social cards). In running copy it's just
Partan.

Anything marked *(coming)* isn't built yet. The [notes at the end](#notes-for-the-team) list each one with its issue,
so the marks can come off as things ship.

---

## 1. Hero

**Headline:** The open-source agent runtime

**Subhead:** Partan runs everything around your agent: durable sessions, sandboxes, its own browsers, a vault that
keeps keys out of the agent's reach, schedules, skills, memory and a model gateway. Run it on Cloudflare or on your own
machine. The prompt is yours. Partan doesn't add one.

**Primary calls to action:**

- Install locally *(coming: the one-line installer; until then this goes to the Docker Compose quick start)*
- Read the docs
- GitHub *(coming: the repository goes public under the lleverage-ai organisation)*

**Lockup:** Partan, by Lleverage

> Visual: the Partan lockup above a short looping capture of the console, a session running with its sandbox, files and
> browser panels open, on a plain background.

---

## 2. What Partan is

**Heading:** What your agent needs, apart from the prompt

A model and a loop make a demo. An agent people rely on also needs somewhere to run commands, a filesystem that
survives a restart, a browser, credentials it can use but never read, a record of what it did, and a way to wake up on
a schedule. Teams usually end up building those pieces themselves, agent by agent.

Partan is those pieces, built once. Each session is durable. It carries on after a crash or a redeploy, and you can
steer it, stop it or fork it mid-run. Commands run in a sandbox with two tiers, a lightweight isolate for file work and
a container for real binaries such as git, both over the same versioned workspace. Every outbound request goes through
the vault, which adds the credential on the way out, so the agent only ever sees a placeholder.

Partan is built on Pi Durable, the durable session engine from the Pi project, and adds the rest of the
infrastructure around it. It has no opinions about what your agent should say. A session's system prompt is the
layers you write, and nothing else.

> Visual: one session drawn as a box, with the pieces around it labelled (sandbox, workspace, browser, vault, audit,
> schedules, skills, memory, models) and the prompt shown as the one part that comes from you.

---

## 3. How it fits together

**Heading:** One runtime underneath, many agents on top

Partan is the open-source base. Products and personal agents sit on top of it and talk to it through the same public
API.

**Partan, the foundation.** Sessions, sandboxes, workspaces, browsers, the vault, audit, schedules, skills, memory and
the model gateway. Open source under Apache-2.0, and yours to run.

**Lleverage, on top.** Lleverage, the commercial product, is moving onto Partan through the public API *(coming)*.
Lleverage keeps what makes it Lleverage: processes, cases, tasks and its inbox. Partan runs the sessions, sandboxes and
credentials underneath. Anything Lleverage does with Partan, your app can do too, because there's no private back
channel.

**Personal agents, alongside.** Personal agents such as Erys, Sal and Alex's Mehen can be packaged on Partan in the
same way *(coming)*. An agent brings its prompt, tools and skills, and Partan supplies the rest.

**Your agent, next.** Build on the API, or open the console and start a session.

> Visual (described for later): three horizontal layers. The bottom layer is a wide band labelled "Partan" holding
> tiles for its components (sessions, sandboxes, workspace, browsers, vault, audit, schedules, skills, memory, model
> gateway). Under it, a thin strip shows where it runs: Cloudflare, self-hosted, your machine. A narrower band across
> the top of Partan is labelled "Public API" (sessions, streaming, approvals). The top layer has separate blocks
> standing on the API band: "Lleverage" (the commercial product, the largest), "Erys", "Sal", "Mehen" and a dashed
> block for "Your agent". Every arrow from the top layer goes through the API band; none reaches into Partan's tiles
> directly. The Partan console sits as one more block on the API band, to show it's a client like the others.

---

## 4. Features

**Heading:** What Partan includes

*(Layout note: grouped for scanning, each group a short heading and a few one-line items.)*

### Sessions that survive

- Durable sessions on Pi Durable. A crash or a redeploy resumes the run instead of losing it.
- Steer an agent mid-run, queue a follow-up, abort, or fork a session to try another direction.
- Switch model mid-conversation. The new model gets the whole transcript.
- Subagents with their own sessions, shown as cards in the parent's thread *(experimental)*.
- Prompt rules layered from the platform down to the organisation, the project and the person. Partan adds none of
  its own.

### Somewhere to work

- Two sandbox tiers over one workspace. File work, `jq` and pipes run in a V8 isolate. `git`, `node` and `python`
  run in a container started on the same files.
- A versioned workspace for every session, with read-only mounts for skills and shared files.
- Partan's own browsers. The agent asks before it opens a site, and you can watch it live or play it back afterwards.
- Documents and files the agent makes open in the console, and you can share them by link.

### Access you control

- A vault that injects credentials at the edge of the sandbox, so the agent sees a placeholder, not the key.
- Agents ask for access. A person narrows the request, checks a binding code that ties it to their session, and
  approves with a passkey.
- Every active grant has a Stop button.
- Organisations, projects, roles and API keys, with sign-in by email code and passkeys for approvals.
- Connections to outside services by OAuth or API key, from a catalogue or a remote MCP server's URL *(coming)*.

### A record of everything

- An append-only audit log of people, agents and the system: credential uses, approvals, denials, sandbox
  escalations and session lifecycle. Filter it and export it as JSONL.
- One usage row per model call, with tokens and cost, by organisation, project, session, agent and model.

### Agents that keep going

- Schedules for recurring tasks and checks, with run history, from the API or the console.
- Skills as Agent Skills packages (a folder with a `SKILL.md`), with immutable revisions that each session pins.
- Memory with bounded recall. A session gets the concepts that match its prompt, and a record of what it was given.
- Agents writing to memory and authoring skills *(coming)*.

### Any model

- A model gateway in front of every call. Sessions never hold a provider key.
- Connectors for Anthropic, OpenAI, OpenRouter, Vercel AI Gateway, LiteLLM and CLIProxyAPI, which lets you use model
  subscriptions you already have.
- Image generation in sessions.

> Visual: a grid of six cards, one per group, each with a small product crop (the transcript, a sandbox command, the
> vault page, the audit log, the schedules page, the model picker). Crops come later, from the real console.

---

## 5. For builders

**Heading:** Headless first

Partan is meant to sit behind your product. Everything goes through a public, versioned API with an OpenAPI document
and a generated TypeScript SDK. The console uses the same API as any other client, so anything it can do, your app can
do.

Create a session with a first message, steer it, stream it over a WebSocket and stop it, from your own backend with an
API key. Ask which models a session can use and switch between them. Vault approvals answered inside your own UI,
with the user's passkey, are *(coming)*, as are webhooks and an organisation-wide event stream that tell you when a
session is waiting on someone.

```ts
// Placeholder: the shape of the current SDK. Package and function names follow the rename.
import { createPartanClient } from "@partan/sdk";

const partan = createPartanClient({ baseUrl: "https://partan.example/v1", token: process.env.PARTAN_API_KEY });

const session = await partan.createSession({
	projectId: "proj-docs",
	agentId: "assistant",
	message: { text: "Summarise the open invoices" },
});

const stream = partan.streamSession(session.id, { onFrames: (frames) => render(frames) });
await partan.sendMessage(session.id, { via: "steer", text: "Only this month's" });
```

**Link:** API reference

> Visual: the snippet on the left; on the right, the same session rendering live in a minimal host app (not the
> Partan console), to make the point that the UI is yours.

---

## 6. Run it anywhere

**Heading:** Cloudflare, your servers or your laptop

The same contracts have a Cloudflare implementation and a self-hosted one, and both have to pass the same conformance
suite.

**On your machine.** One line installs Partan and prints the console's address *(coming)*. Today, one Docker Compose
command starts the whole self-hosted stack on one machine.

**On Cloudflare.** One Worker serves the API and the console. Sessions live in Durable Objects, workspaces in R2, the
directory and audit in D1, and the container tier runs on Cloudflare Containers.

**On your own servers.** Session hosts on Bun with Postgres, MinIO or S3 for workspaces, workerd for the isolate tier,
and Docker for containers, with gVisor if you want a stronger boundary. Kubernetes and a Helm chart are *(coming)*.

> Visual: three columns, one per place, each with its logo or an icon and the one command or service list beneath
> it, joined at the bottom by one line reading "same API, same conformance suite".

---

## 7. Quick start

**Heading:** From install to first answer

1. **Install.** *(coming)* Run the installer on a Linux machine with Docker. It checks what it needs, writes config
   with generated secrets, starts Partan and prints the console address and a one-time sign-in link.

   ```sh
   curl -fsSL <release host>/install.sh | sh
   ```

   Until it ships: `docker compose -f deploy/compose/compose.yaml up -d --build --wait`.

2. **Connect your models.** *(coming as first-run onboarding)* The console's first visit asks for a model provider:
   an API key, or your existing subscriptions through CLIProxyAPI. Today this is set in the deployment's config.

3. **Add your first connections.** *(coming)* Pick the services your agent should reach, such as GitHub or Linear,
   and connect them by OAuth or key. The keys go into the vault, never into the agent.

4. **Start a session.** Choose an agent, or write a prompt for a new one, and type your first message. Onboarding
   adds nothing to the prompt; an agent you create starts with an empty one until you write it.

> Visual: a four-step strip, each step a small console screenshot (terminal, model connect, connections, first
> session). Use placeholders until onboarding exists.

---

## 8. Open source and community

**Heading:** Open source, Apache-2.0

Partan's code is licensed under Apache-2.0, and it's going public under the lleverage-ai organisation on GitHub
*(coming)*. You can read it, run it, change it and ship it inside your own product.

Every component is a contract with an in-memory implementation and a conformance suite, so you can add a backend or a
target and check it against the same tests ours pass.

**Calls to action:** Star on GitHub *(coming)*, Read the contributing guide *(coming)*, Report an issue *(coming)*

> Visual: a plain panel with the GitHub mark, the licence name and a short list of the repository's top folders
> (`apps/`, `packages/`, `targets/`, `deploy/`), no stock community imagery.

---

## 9. FAQ

**Heading:** Questions

**Is Partan an agent harness?**
It contains one. The harness is the loop that sends a prompt to a model and runs the tools it asks for. Partan uses Pi
Durable for that, then adds what the loop runs inside: sandboxes, workspaces, browsers, the vault, audit, schedules,
skills, memory and the model gateway. That's why we call it a runtime.

**Does Partan add its own system prompt?**
No. A session's system prompt is the layers you set (platform, organisation, project, agent and person). If you set
none, the model gets no system prompt.

**Can my agent read my API keys?**
No. Credentials stay in the vault, which adds them to outbound requests for the hosts they're bound to. Inside the
sandbox there's only a placeholder.

**Which models can I use?**
Anything behind Anthropic, OpenAI, OpenRouter, Vercel AI Gateway, LiteLLM or CLIProxyAPI. Agents name a route, such
as `default`, and the model gateway decides which connector serves it.

**Do I need Cloudflare?**
No. Partan runs on Cloudflare or self-hosted, and the self-hosted stack runs on one machine.

**Do I have to use the console?**
No. The console ships so you can start without writing code, but the API is the main way in.

**How does Partan relate to Lleverage?**
Partan is the open-source runtime. Lleverage is the commercial product, and it's moving onto Partan through the
public API *(coming)*.

**Is it ready for production?**
Not yet. Partan is early and changes quickly. The roadmap is on GitHub as milestones M0 to M3, public once the
repository is.

> Visual: a plain accordion. No illustration.

---

## 10. Footer

**Lockup:** Partan, by Lleverage

**Columns:**

- Product: Features, Run anywhere, Quick start, API
- Docs: Console guide, API reference, Self-hosting, Cloudflare
- Open source: GitHub *(coming)*, Licence (Apache-2.0), Roadmap (milestones)
- Lleverage: lleverage.ai, Contact

**Line:** Partan is open source under the Apache-2.0 licence. Built by Lleverage.

> Visual: the lockup on the left, link columns on the right, small type.

---

## Notes for the team

### Positioning: runtime, not harness

Use "open-source agent runtime" as the category in headlines. A harness is the agent loop: prompt, model call, tool
call, repeat. Partan includes one (Pi Durable), but most of what it does is the infrastructure around the loop:
sandboxes, workspace, browsers, vault, audit, schedules, skills, memory and models. Calling it a harness undersells
that and puts it next to frameworks it doesn't compete with. "Runtime" says it's the thing your agent runs on.
"Platform" is accurate too, but it reads like a hosted service, which pulls against "run it yourself". Keep "platform"
for body copy where it helps.

Alternative taglines to choose from:

1. The open-source agent runtime. *(used in the hero)*
2. Everything your agent needs, apart from the prompt.
3. Run agents you own, on infrastructure you choose.

Hero headline and subhead options:

| Headline | Subhead |
| --- | --- |
| The open-source agent runtime | Partan runs everything around your agent: durable sessions, sandboxes, its own browsers, a vault that keeps keys out of the agent's reach, schedules, skills, memory and a model gateway. Run it on Cloudflare or on your own machine. The prompt is yours. Partan doesn't add one. |
| Everything your agent needs, apart from the prompt | Partan is an open-source agent runtime. Sessions that survive restarts, sandboxes, browsers and a credential vault, behind one API, on Cloudflare or your own servers. |
| Run agents you own, on infrastructure you choose | Partan is the open-source runtime under Lleverage. Build your own product or personal agent on the same API, and run it on Cloudflare or a laptop. |

### Claims marked coming, and why

| Claim | Why it's marked | Where it's tracked |
| --- | --- | --- |
| Public GitHub repository under lleverage-ai | The repository is still private at tvdavies/harbour | The rename and move |
| One-line installer | Not built; today it's the Docker Compose stack | [#156](https://github.com/tvdavies/harbour/issues/156) (M3-SH2) |
| First-run onboarding in the console (models, connections, first agent) | Not built; model connectors are set in config today | [#156](https://github.com/tvdavies/harbour/issues/156) (M3-SH2) |
| Connections by OAuth or key, catalogue, remote MCP servers | API contract and routes defined ([#380](https://github.com/tvdavies/harbour/pull/380)); no server serves them yet; console page not built | [#322](https://github.com/tvdavies/harbour/issues/322), [#338](https://github.com/tvdavies/harbour/issues/338), [#339](https://github.com/tvdavies/harbour/issues/339) |
| Vault approvals answered in a host app through the API | Approvals work on Partan's own vault page today, not through the public API | [#185](https://github.com/tvdavies/harbour/issues/185), [#150](https://github.com/tvdavies/harbour/issues/150) |
| Webhooks and an organisation-wide event stream | Not built | [#186](https://github.com/tvdavies/harbour/issues/186) |
| Lleverage running on Partan | A phased plan, not started | [Plan v2, section 11](https://files.myslop.app/6278860afc/harbour-plan-v2-2026-10-27.html), [#33](https://github.com/tvdavies/harbour/issues/33) (M3-BE4) |
| Personal agents (Erys, Sal, Mehen) packaged on Partan | Sal's Partan placement exists behind an experimental flag; a real Sal task end to end is still open; there's no packaging format yet | [#14](https://github.com/tvdavies/harbour/issues/14), [#232](https://github.com/tvdavies/harbour/issues/232), [#250](https://github.com/tvdavies/harbour/issues/250) |
| Kubernetes and a Helm chart | Only the browser host has Kubernetes manifests | [#35](https://github.com/tvdavies/harbour/issues/35) (M3-SH1) |
| Agents writing memory and authoring skills | Read side and import only today | [#25](https://github.com/tvdavies/harbour/issues/25) (M2-BE5) |
| Contributing guide, issue templates | Don't exist yet | None |
| Subagents | Built, labelled experimental | None |

### Other points to check

- **Subscriptions through CLIProxyAPI.** The copy says CLIProxyAPI lets you use model subscriptions you already have.
  That's how the gateway works, but check each provider's terms before a public site promises it.
- **"Agent providers".** The brief's onboarding mentions agent providers alongside model subscriptions. The installer
  issue's quickstart lists a model connector, a first agent profile and a first attached machine. The copy says
  "choose an agent" for now; adjust once onboarding is designed.
- **Self-hosted container tier.** The Compose stack's gateway doesn't have the container tier behind it yet (its
  session hosts do), so commands that need a container are refused there today. Don't demo `git` on the local stack
  until that lands.
- **Code names.** The SDK snippet uses `@partan/sdk` and `createPartanClient`, which assume the rename. Today they're
  `@harbour/api/sdk` and `createHarbourClient`.
- **Erys.** Its repository (erys-ai/erys, private) describes it as "an agent toolkit. Lightweight agents on
  Cloudflare". The copy calls it a personal agent, as the brief does; check that's how Erys wants to be named.
- **Mehen and Sal.** The copy names them only as personal agents that can be packaged on Partan. Add detail only once
  Alex and the Sal side confirm it.
