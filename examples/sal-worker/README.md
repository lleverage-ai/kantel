# Sal worker skills and memory on Harbour

A Sal worker's skills and memory composed from Harbour's packages, and a harness that checks a Harbour Sal worker is
given what a local Sal worker is given for the same task (issue #12).

- `src/okf.ts`: Sal's memory bundle (OKF v0.2 concept files in tvdavies/sal-memory) as a `MemorySnapshot`. It reads
  status, scope, job exceptions, the `profile` tag and `learned_from` the way Sal's `summarise` does, and keeps what
  Harbour has no field for in the `sal` extension. A concept Sal reads but a snapshot cannot hold (an empty title or
  body, an empty `applies_to`, an `overrides` that is not a concept ID) is refused on its own, and the rest of the
  bundle is still imported. A `generated.at` that is not a real time in the form YAML gives a date gets a warning,
  because Sal orders the profile by that text.
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
- `src/recall-renderer.ts`: a `RecallRenderer` that renders `<memory_recall>` exactly as a Sal worker receives it.
  Budgets count rendered bytes, so the same renderer gives the same selection.
- `src/worker.ts`: `prepareSalWorker` imports the bundle and publishes the skills, each at its pinned ref, with Sal's
  worker exclusions. `startSalWorkerSession` pins a session's skills and returns its listing, Pi's prompt block and
  its recall. Concepts the brief names, and their exceptions for the task, are left out of recall as Sal's selection
  leaves them out. `host.skillsMount` serves the pinned packages read-only at `/skills`.

## Parity with a local Sal

`scripts/sal-local.ts` runs under Bun against an installed Sal release, and only reads. It calls Sal's own
`planPiSetup` and `assembleLaunchContext` for the worker role with a pinned sal-memory clone. For skills it calls Pi's
`loadSkills` over the paths Sal's runner passes (`piRunnerInputs`), filtered as the runner filters them. That is what
the worker actually loads. Sal's launch manifest is reported beside it.

`scripts/harbour-sal.ts` runs the Harbour side from a config file. `scripts/parity.ts` compares:
- recalled concepts and reasons
- the recall text, byte for byte
- skipped concepts
- the skill set
- each skill's `SKILL.md` and whole package digest
- the entries of Pi's `<available_skills>` block

Locations are ignored because Harbour mounts skills at `/skills`. The order of the entries is reported but does not
fail the run (see below).

```sh
# per task: what the local Sal worker gets
bun examples/sal-worker/scripts/sal-local.ts --sal ~/.local/share/sal/current --config ~/.config/sal/sal.json \
  --memory <sal-memory clone> --task TASK-1 --brief <BRIEF.md> --workspace <task workspace> --now 2026-10-27T20:00:00Z > sal-TASK-1.json
# all tasks: what a Harbour Sal worker gets
node examples/sal-worker/scripts/harbour-sal.ts --config parity.json > harbour.json
node examples/sal-worker/scripts/parity.ts --harbour harbour.json --sal TASK-1=sal-TASK-1.json
```

`parity.json` names the memory clone and commit, the skill sources in Pi's order with each one's mode, and the tasks;
see the header of `scripts/harbour-sal.ts`. On 27 October 2026 the harness ran five real Sal worker briefs. The pins
were:
- sal-memory `7fbf30f6`
- agent-toolkit `556e4213`, in `agents` mode
- Sal's skills `8d48d2a0`
- directory digests for `~/.pi/agent/skills`, the synced Claude skills (`agents` mode) and the pi-subagents package

All five tasks matched: 41 profile concepts plus 4 matches each, recall text of 27,811 to 28,128 bytes, 64 skills
with identical packages, and the same 57 prompt entries. A control run with the older sal-memory commit and one fewer
exclusion was flagged on every task.

## Known differences and gaps

- Pi lists skills in its prompt in the order the file system returns directory entries. A pinned tree has no such
  order, so Harbour's order differs, though the entries are the same.
- The harness models `~/.agents/skills` as agent-toolkit's `skills/` directory at a commit plus the synced directory.
  On this host every entry in `~/.agents/skills` links into those, so the skills are the same. A plain `.md` file
  placed directly in a toolkit category directory would be found here but not by Pi.
- Packages leave out hidden files and `node_modules`, and a skill from a plain `.md` file is that file alone. Pi can
  read anything on disk under a skill's directory.

- Pi does not load a skill whose frontmatter is not valid YAML (agent-toolkit's `brwsr-browse` at `556e4213`), but
  Sal's launch manifest still lists it. Harbour follows Pi, so the worker never sees it. The harness reports it as
  `notLoaded`.
- Grants can bring an excluded skill back for one task (Sal's `withGrantedSkills`). Harbour publishes one set per
  owner, so a per-task exclusion would need a per-session visibility. None of the five tasks had such a grant.
- Sal's `deprecated` concepts become `forgotten`. They stay inactive, but a skip reason reads `forgotten`, not
  `deprecated`.
- Sal reranks recall with a model only in conversations. Workers use BM25 alone, as here.
