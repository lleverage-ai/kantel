# Pi worker skills and memory on Kantel

This example builds a Pi worker's skills and memory into Kantel, using Kantel's packages. The worker's memory is an
OKF bundle in a Git repository. Its skills come from Git repositories and plain directories. A harness checks that a
Kantel session gives the worker what it gets when it runs locally for the same task.

The example was written for a Pi-based agent called Sal, so the code uses `sal` names (`prepareSalWorker`, the `sal`
extension, the default memory space "Sal memory"). The bundle format it reads and the recall it renders follow that
agent's conventions. Only the local side of the parity harness (`scripts/sal-local.ts`) needs the agent itself.

## What is in it

- `src/okf.ts`: reads the memory bundle (OKF v0.2 concept files, under `knowledge/` by default) as a
  `MemorySnapshot`. Each concept file is YAML frontmatter and a Markdown body. It reads status, scope, job exceptions
  (`sal.applies_to` and `sal.overrides`), the `profile` tag and `sal.learned_from`, and keeps what Kantel has no field
  for in the `sal` extension. A concept the snapshot cannot hold (an empty title or body, an empty `applies_to`, an
  `overrides` that is not a concept ID) is refused on its own, and the rest of the bundle is still imported. A
  `generated.at` that is not a real time in the form YAML gives a date gets a warning, because the profile is ordered
  by that text. Writing goes the other way: `okfConceptText` renders a Kantel concept as a concept file (active,
  superseded with its note, or forgotten). It keeps a file's unknown fields and source details, and keeps its bytes
  when it already says the same. `okfIndexes` rewrites the directory indexes above changed concepts, never the root
  one.
- `src/memory-source.ts`: `salMemorySource`, the memory repository as a `MemorySource` both ways. `snapshot(ref)`
  feeds `importSnapshot`, and `publish` with `render` feeds `withBundlePublishing`. Publishing commits changed concept
  files and their indexes to a branch through `commitFiles` (`src/git.ts`). That uses Git objects and a throwaway
  index, never a checkout, and commits only if the branch has not moved. Nothing outside the bundle, and no concept
  file Kantel does not hold, is touched. Point it at a clone of its own (bare, or with the branch not checked out);
  pushing that clone is the host's job.
- `src/skill-sources.ts`: skill sources pinned per ref. A source is either a Git repository at a commit or a
  directory pinned by a digest of its contents (skills installed without Git). Discovery follows Pi's loader:
  - a directory with `SKILL.md` is a skill, and nothing below it is searched
  - plain `.md` files count at the root (`pi` mode) or below it (`agents` mode, for `~/.agents/skills`)
  - ignore files apply
  - the first skill of a name wins
  - symlinks are followed. In a Git source, a link that dangles, leaves the commit or leads back to a link already
    followed is left out and reported, and so is a fan-out past 100,000 paths. In a directory, as in Pi, a dangling
    link is passed over and a directory already open is not entered again. An entry that cannot be read (a link to
    itself) is passed over and reported.
  - a file reached through several paths loads once, and a name is taken once, across sources too.
    `layerSalSources` adds the skill files a later source must leave out to its ref (`<pin>?skip=...`), so a ref
    still gives one set of skills. Such a skill is reported among the source's problems, not as shadowed.

  A directory's digest covers which paths are one file, since that decides what loads. Tests check discovery against
  Pi's own `loadSkills`, for one root and for several sharing files. Binary files are left out (a `SkillFile` is
  text) and recorded in the revision's `sal.binaryLeftOut`.
- The recall renderer is `salRecallRenderer` in `@kantel/memory` (`packages/memory/src/sal-recall.ts`), so a
  deployment can use it too. It is a `RecallRenderer` that renders `<memory_recall>` exactly as a local worker
  receives it. Budgets count rendered bytes, so the same renderer gives the same selection. Here it is given Node's
  `existsSync`, so a concept's local sources are checked on this host.
- `src/worker.ts`: `prepareSalWorker` imports the bundle and publishes the skills, each at its pinned ref, leaving
  out the worker exclusions (`SAL_WORKER_EXCLUDED_SKILLS`: skills that act as the owner or need tools a worker lacks)
  unless the config's `exclude` replaces them. `startSalWorkerSession` pins a session's skills and returns its
  listing, Pi's `<available_skills>` prompt block and its recall. Concepts the brief names, and their exceptions for
  the task, are left out of recall, as the local worker's selection leaves them out. `host.skillsMount` serves the
  pinned packages read-only at `/skills`.

Run the tests with `pnpm --filter @kantel/example-sal-worker test`. The memory source tests run on a fixture. When
`SAL_MEMORY_REPO` names a clone of a real memory repository, they also run on a bare clone of it: the whole bundle
round-trips without a commit, every index is reproduced exactly, and one applied write commits only its file and its
directory's index.

## The config

`scripts/kantel-sal.ts` and `scripts/import-to-kantel.ts` read the same JSON config. Paths are absolute or relative
to the config file (`~` is not expanded).

```json
{
	"memory": { "repo": "<memory clone>", "ref": "<commit>", "bundleDir": "knowledge" },
	"skills": [
		{ "id": "pi-agent-skills", "dir": "/home/me/.pi/agent/skills" },
		{ "id": "agent-skills", "git": "<repo>", "paths": ["skills"], "ref": "<commit>", "mode": "agents" }
	],
	"exclude": ["<skill name>"],
	"tasks": [{ "task": "<task>", "brief": "<brief file>", "concepts": ["<concept ID>"] }],
	"now": "<ISO time>"
}
```

- `memory`: the clone, the commit to pin and the bundle directory in it (default `knowledge`).
- `skills`: the sources in Pi's order; on a name more than one offers, the first wins. A Git source has `git` and
  `paths`, a directory source has `dir`. `ref` pins a source (default its current commit or digest). `mode` is Pi's
  search mode for the root: `pi` (the default), or `agents` for what Pi finds under `~/.agents/skills`.
- `exclude`: skill names to leave out, in place of `SAL_WORKER_EXCLUDED_SKILLS`. Optional.
- `limits`: recall limits (`maxConcepts`, `maxBytes`, `maxProfileConcepts`, `maxProfileBytes`), in place of
  `SAL_DEFAULT_RECALL_LIMITS`. Optional, and read only by `kantel-sal.ts`.
- `tasks` and `now`: the tasks to start a session for, each with its brief and any concepts it names, and the clock.
  Read only by `kantel-sal.ts`.

## Loading the skills and memory into a deployed Kantel

`scripts/import-to-kantel.ts` reads the config (without `tasks`) and loads it into a Kantel through the public API.
Each skill goes in with `POST /v1/skills/import`, owned by the caller's organisation. The bundle goes into a memory
space (`Sal memory` by default, or `--space <name>`) with `POST /v1/memory/spaces/{spaceId}/snapshot`. The space is
made if missing and the caller may make it. With `--profile <agent ID>` it then names them on that agent's profile
(`PUT /v1/profiles/{agentId}`): the skills Pi lists in a worker's prompt (those without `disable-model-invocation`),
and the space beside the profile's other memory scopes. That agent's new sessions then list the skills, read them at
`/skills` and get recall. A second run at the same refs publishes nothing new.

The Kantel and the credentials come from the environment, never the command line or the repository:

| Variable | What |
| --- | --- |
| `KANTEL_URL` | The Kantel's base URL (or `--url`) |
| `KANTEL_API_KEY` | An `hbr_` key, sent as `Authorization: Bearer` |
| `KANTEL_ACCESS_TOKEN` | A signed-in person's Cloudflare Access token, sent as `Cf-Access-Jwt-Assertion` |

`--header "Name: value"` adds a header to every request, and can be given more than once.

The normal path is `KANTEL_API_KEY` with a key that carries the `import` permission. Importing skills and snapshots
is otherwise the organisation admin's. The permission lets a key make those two calls (`POST /v1/skills/import` and
`POST /v1/memory/spaces/{spaceId}/snapshot`) and nothing else an admin may do. An `operator` key on the project also
sets the profile. A key without the permission is refused both imports with 403.

An organisation admin does two things once: mints the key, and makes the memory space, since creating a space is
still the admin's. Instead of making the space by hand, the admin can run the script once signed in, with
`KANTEL_ACCESS_TOKEN`, which makes it. Mint the key on the console's API keys page, or with `POST /v1/keys` while
signed in:

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
  -d "{\"name\":\"Worker import\",\"projectIds\":[\"$PROJECT\"],\"role\":\"operator\",\"permissions\":[\"import\"]}" \
  | jq -r .secret
```

Then, and on every later run:

```sh
KANTEL_URL=http://localhost:8787 KANTEL_API_KEY=<the key, from your secret store> \
  node examples/sal-worker/scripts/import-to-kantel.ts --config worker.json --profile assistant
# or write the requests to send from somewhere already signed in
node examples/sal-worker/scripts/import-to-kantel.ts --config worker.json --out requests.json
```

With `--out`, the requests are written as JSON (`{ organisation, skills, space, snapshot }`, with `<organisation>`
standing in for the owner's organisation) instead of being sent. The script prints a JSON summary on stdout.

The content is the owner's: keep the config, the requests and anything printed out of the repository.

## Parity with a local worker

`scripts/sal-local.ts` runs under Bun against an installed release of the agent, and only reads. It uses the agent's
own launch code for the worker role, with a pinned clone of the memory repository, to get the recall a local worker
receives for a brief. For skills it calls Pi's `loadSkills` over the paths the agent's runner passes, filtered by the
role's names and exclusions as the runner filters them. That is what the worker actually loads. The agent's launch
manifest is reported beside it, since it can list a skill Pi does not load (`notLoaded`). Each skill's digest is
Kantel's `skillDigest` over its UTF-8 files, so the two sides compare whole packages.

`scripts/kantel-sal.ts` runs the Kantel side from the config: it imports the bundle and the skill sources once, then
starts one session per task and prints JSON in the same shape, plus the pins. With `--store <dir>` it keeps memory
and skills in the durable SQL stores (a `node:sqlite` database in `<dir>` and file bodies under `<dir>/objects`)
instead of the in-memory ones; run it twice on one directory to check a restart gives the same output.

`scripts/parity.ts` compares:
- recalled concepts and reasons
- the recall text, byte for byte
- skipped concepts
- the memory ref
- the skill set
- each skill's `SKILL.md` and whole package digest
- the entries of Pi's `<available_skills>` block

Locations are ignored because Kantel mounts skills at `/skills`. The order of the entries is reported but does not
fail the run (see below). It prints a Markdown report and exits 1 on any difference.

```sh
# per task: what the local worker gets
bun examples/sal-worker/scripts/sal-local.ts --sal <agent release> --config <agent config file> \
  --memory <memory clone> --task <task> --brief <brief file> --workspace <task workspace> --now <ISO time> > local-1.json
# all tasks: what a Kantel worker gets
node examples/sal-worker/scripts/kantel-sal.ts --config parity.json > kantel.json
node examples/sal-worker/scripts/parity.ts --harbour kantel.json --sal <task>=local-1.json
```

`sal-local.ts` also takes `--concepts <id,id>` (the concepts the brief names) and `--state <dir>` (the agent's state
directory, used only for where an isolated Pi setup keeps its agent directory). Give `parity.ts` one `--sal` per
task. Use the same memory commit and skill refs on both sides, or every task is flagged.

## Known differences and gaps

- A Cloudflare session recalls with this renderer only when the deployment sets `KANTEL_RECALL_RENDERER=sal`
  (`apps/cloudflare/src/recall-renderer.ts`); the default is Kantel's own. Budgets count rendered bytes, so with the
  default the profile and matches can differ from a local worker's at the budget's edge.
- A Worker has no file system, so on Cloudflare the renderer counts every local source (an absolute path or `file:`
  URL) as missing, as the local host does for a path it no longer has. A concept naming a path that does exist on
  the local host renders `missing_sources` on Cloudflare and not locally.
- Pi lists skills in its prompt in the order the file system returns directory entries. A pinned tree has no such
  order, so Kantel's order differs, though the entries are the same.
- A config can model `~/.agents/skills` as a Git source's `skills/` directory at a commit (in `agents` mode) plus a
  directory source. That gives the same skills only when every entry in `~/.agents/skills` links into those sources.
  A plain `.md` file placed directly in a category directory of the Git source is found here but not by Pi.
- Packages leave out hidden files and `node_modules`, and a skill from a plain `.md` file is that file alone. Pi can
  read anything on disk under a skill's directory.
- Pi does not load a skill whose frontmatter is not valid YAML, but the agent's launch manifest still lists it.
  Kantel follows Pi, so the worker never sees it. The harness reports it as `notLoaded`.
- The agent can grant an excluded skill back for one task. Kantel publishes one set per owner, so a per-task
  exclusion would need per-session visibility.
- `deprecated` concepts become `forgotten`. They stay inactive, but a skip reason reads `forgotten`, not
  `deprecated`.
- The agent reranks recall with a model only in conversations. Workers use BM25 alone, as here.
