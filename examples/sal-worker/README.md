# Sal worker skills and memory on Kantel

A Sal worker's skills and memory composed from Kantel's packages, and a harness that checks a Kantel Sal worker is
given what a local Sal worker is given for the same task (issue #12).

- `src/okf.ts`: Sal's memory bundle (OKF v0.2 concept files in tvdavies/sal-memory) as a `MemorySnapshot`. It reads
  status, scope, job exceptions, the `profile` tag and `learned_from` the way Sal's `summarise` does, and keeps what
  Kantel has no field for in the `sal` extension. A concept Sal reads but a snapshot cannot hold (an empty title or
  body, an empty `applies_to`, an `overrides` that is not a concept ID) is refused on its own, and the rest of the
  bundle is still imported. A `generated.at` that is not a real time in the form YAML gives a date gets a warning,
  because Sal orders the profile by that text. Writing goes the other way (M2-BE5, issue #25): `okfConceptText` renders
  a Kantel concept as Sal's writer does (active, superseded with its note, forgotten), keeping a file's unknown fields
  and source details, and keeping its bytes when it already says the same; `okfIndexes` rewrites the directory
  indexes above changed concepts, never the root one.
- `src/memory-source.ts`: `salMemorySource`, sal-memory as a `MemorySource` both ways: `snapshot(ref)` for
  `importSnapshot`, and `publish` with `render` for `withBundlePublishing`, committing changed concept files and their
  indexes to a branch through `commitFiles` (`src/git.ts`: objects and a throwaway index, never a checkout, and only
  if the branch has not moved). Nothing outside the bundle, and no concept file Kantel does not hold, is touched.
  Tests run it on a fixture and, when `~/dev/tvdavies/sal-memory` (or `SAL_MEMORY_REPO`) exists, on a bare clone of
  the real repository: the whole bundle round-trips without a commit, every index Sal wrote is reproduced exactly, and
  one applied write commits only its file and its directory's index.
- `src/skill-sources.ts`: skill sources pinned per ref, either a Git repository at a commit (Tom's agent-toolkit, Sal's
  own skills) or a directory pinned by a digest of its contents (skills installed without Git). Discovery follows Pi's
  loader:
  - a directory with `SKILL.md` is a skill, and nothing below it is searched
  - plain `.md` files count at the root (`pi` mode) or below it (`agents` mode, for `~/.agents/skills`)
  - ignore files apply
  - the first skill of a name wins
  - symlinks are followed. In a Git source, a link that dangles, leaves the commit or leads back to a link already
    followed is left out and reported, and so is a fan-out past 100,000 paths. In a directory, as in Pi, a dangling
    link is passed over and a directory already open is not entered again; an entry that cannot be read (a link to
    itself) is passed over and reported.
  - a file reached through several paths loads once, and a name is taken once, across sources too. `layerSalSources`
    adds the skill files a later source must leave out to its ref (`<pin>?skip=...`), so a ref still gives one set of
    skills. Such a skill is reported among the source's problems, not as shadowed.

  A directory's digest covers which paths are one file, since that decides what loads. Tests check discovery against
  Pi's own `loadSkills`, for one root and for several sharing files. Binary files are left out (a `SkillFile` is text)
  and recorded in the revision's `sal.binaryLeftOut`.
- Sal's recall rendering is `salRecallRenderer` in `@kantel/memory` (`packages/memory/src/sal-recall.ts`), so a
  deployment can use it too: a `RecallRenderer` that renders `<memory_recall>` exactly as a Sal worker receives it.
  Budgets count rendered bytes, so the same renderer gives the same selection. Here it is given Node's `existsSync`,
  so a concept's local sources are checked on this host as Sal checks them.
- `src/worker.ts`: `prepareSalWorker` imports the bundle and publishes the skills, each at its pinned ref, with Sal's
  worker exclusions. `startSalWorkerSession` pins a session's skills and returns its listing, Pi's prompt block and
  its recall. Concepts the brief names, and their exceptions for the task, are left out of recall as Sal's selection
  leaves them out. `host.skillsMount` serves the pinned packages read-only at `/skills`.

## Loading Sal's skills and memory into a deployed Kantel

`scripts/import-to-kantel.ts` reads what `kantel-sal.ts` reads (the same config, without tasks) and loads it into a
Kantel through the public API: each skill with `POST /v1/skills/import`, owned by the caller's organisation, and the
bundle into a memory space (`Sal memory`, made if missing) with `POST /v1/memory/spaces/{spaceId}/snapshot`. With
`--profile <agent ID>` it then names them on that agent's profile (`PUT /v1/profiles/{agentId}`): the skills Pi lists in
a worker's prompt, and the space beside the profile's other memory scopes. That agent's new sessions then list the
skills, read them at `/skills` and get recall. A second run at the same refs publishes nothing new.

The Kantel and the credentials come from the environment, never the command line or the repository:

| Variable | What |
| --- | --- |
| `KANTEL_URL` | The Kantel's base URL (or `--url`) |
| `KANTEL_API_KEY` | An `hbr_` key, sent as `Authorization: Bearer` |
| `KANTEL_ACCESS_TOKEN` | A signed-in person's Cloudflare Access token, sent as `Cf-Access-Jwt-Assertion` |

The normal path is `KANTEL_API_KEY` with a key that carries the `import` permission. Importing skills and snapshots
is otherwise the organisation admin's; the permission lets a key make those two calls (`POST /v1/skills/import` and
`POST /v1/memory/spaces/{spaceId}/snapshot`) and nothing else an admin may do. An `operator` key on the project also
sets the profile. A key without the permission is refused both imports with 403.

An organisation admin does two things once: mints the key, and makes the memory space, since creating a space is still
the admin's (or run the script once signed in, with `KANTEL_ACCESS_TOKEN`, which makes it). Mint the key on the
console's API keys page, or with `POST /v1/keys` while signed in:

```sh
# local: pnpm --filter @kantel/cloudflare dev; the dev admin signs in with the mock Access token
export KANTEL_URL=http://localhost:8787
ADMIN="cf-access-jwt-assertion: $(curl -s $KANTEL_URL/__dev/access-token | jq -r .token)"
PROJECT=$(curl -s -H "$ADMIN" $KANTEL_URL/v1/projects | jq -r '.items[0].id')
# the space, once
curl -s -H "$ADMIN" -H 'content-type: application/json' $KANTEL_URL/v1/memory/spaces \
  -d "{\"owner\":{\"kind\":\"organisation\",\"organisationId\":\"$(curl -s -H "$ADMIN" $KANTEL_URL/v1/me | jq -r .organisationId)\"},\"name\":\"Sal memory\"}"
# the key: its secret is in this one answer only, so put it straight into your secret store
curl -s -H "$ADMIN" -H 'content-type: application/json' $KANTEL_URL/v1/keys \
  -d "{\"name\":\"Sal import\",\"projectIds\":[\"$PROJECT\"],\"role\":\"operator\",\"permissions\":[\"import\"]}" \
  | jq -r .secret
```

Then, and on every later run:

```sh
KANTEL_URL=http://localhost:8787 KANTEL_API_KEY=<the key, from your secret store> \
  node examples/sal-worker/scripts/import-to-kantel.ts --config sal.json --profile assistant
# or write the requests to send from somewhere already signed in
node examples/sal-worker/scripts/import-to-kantel.ts --config sal.json --out requests.json
```

The content is the owner's: keep the config, the requests and anything printed out of the repository.

## Parity with a local Sal

`scripts/sal-local.ts` runs under Bun against an installed Sal release, and only reads. It calls Sal's own
`planPiSetup` and `assembleLaunchContext` for the worker role with a pinned sal-memory clone. For skills it calls Pi's
`loadSkills` over the paths Sal's runner passes (`piRunnerInputs`), filtered as the runner filters them. That is what
the worker actually loads. Sal's launch manifest is reported beside it.

`scripts/kantel-sal.ts` runs the Kantel side from a config file. `scripts/parity.ts` compares:
- recalled concepts and reasons
- the recall text, byte for byte
- skipped concepts
- the skill set
- each skill's `SKILL.md` and whole package digest
- the entries of Pi's `<available_skills>` block

Locations are ignored because Kantel mounts skills at `/skills`. The order of the entries is reported but does not
fail the run (see below).

```sh
# per task: what the local Sal worker gets
bun examples/sal-worker/scripts/sal-local.ts --sal ~/.local/share/sal/current --config ~/.config/sal/sal.json \
  --memory <sal-memory clone> --task TASK-1 --brief <BRIEF.md> --workspace <task workspace> --now 2026-10-27T20:00:00Z > sal-TASK-1.json
# all tasks: what a Kantel Sal worker gets
node examples/sal-worker/scripts/kantel-sal.ts --config parity.json > harbour.json
node examples/sal-worker/scripts/parity.ts --harbour harbour.json --sal TASK-1=sal-TASK-1.json
```

`parity.json` names the memory clone and commit, the skill sources in Pi's order with each one's mode, and the tasks;
see the header of `scripts/kantel-sal.ts`. On 27 October 2026 the harness ran five real Sal worker briefs. The pins
were:
- sal-memory `7fbf30f6`
- agent-toolkit `556e4213`, in `agents` mode
- Sal's skills `8d48d2a0`
- directory digests for `~/.pi/agent/skills`, the synced Claude skills (`agents` mode) and the pi-subagents package

All five tasks matched: 41 profile concepts plus 4 matches each, recall text of 27,811 to 28,128 bytes, 64 skills
with identical packages, and the same 57 prompt entries. A control run with the older sal-memory commit and one fewer
exclusion was flagged on every task.

## Known differences and gaps

- A Cloudflare session recalls with Sal's renderer only when the deployment sets `KANTEL_RECALL_RENDERER=sal`
  (`apps/cloudflare/src/recall-renderer.ts`); the default is Kantel's own. Budgets count rendered bytes, so with the
  default its profile and matches differ from a local Sal worker's at the budget's edge: on 29 October 2026, with
  sal-memory `9a3cdfd7` and five worker briefs, it kept 38 of Sal's 41 profile concepts and one or two matches
  differed. With `sal`, on `wrangler dev` the same five briefs gave the same recall as a local Sal worker: the same
  concepts, text, profile omissions and skipped concepts, with the skills and prompt entries matching too.
- A Worker has no file system, so on Cloudflare Sal's renderer counts every local source (an absolute path or
  `file:` URL) as missing, as Sal's host does for a path it no longer has. At sal-memory `9a3cdfd7` that is what
  Sal's host reports too: 5 active concepts name 6 local paths, and none exists there. A concept naming a path that
  does exist on Sal's host would render `missing_sources` on Cloudflare and not locally.

- Pi lists skills in its prompt in the order the file system returns directory entries. A pinned tree has no such
  order, so Kantel's order differs, though the entries are the same.
- The harness models `~/.agents/skills` as agent-toolkit's `skills/` directory at a commit plus the synced directory.
  On this host every entry in `~/.agents/skills` links into those, so the skills are the same. A plain `.md` file
  placed directly in a toolkit category directory would be found here but not by Pi.
- Packages leave out hidden files and `node_modules`, and a skill from a plain `.md` file is that file alone. Pi can
  read anything on disk under a skill's directory.

- Pi does not load a skill whose frontmatter is not valid YAML (agent-toolkit's `brwsr-browse` at `556e4213`), but
  Sal's launch manifest still lists it. Kantel follows Pi, so the worker never sees it. The harness reports it as
  `notLoaded`.
- Grants can bring an excluded skill back for one task (Sal's `withGrantedSkills`). Kantel publishes one set per
  owner, so a per-task exclusion would need a per-session visibility. None of the five tasks had such a grant.
- Sal's `deprecated` concepts become `forgotten`. They stay inactive, but a skip reason reads `forgotten`, not
  `deprecated`.
- Sal reranks recall with a model only in conversations. Workers use BM25 alone, as here.
