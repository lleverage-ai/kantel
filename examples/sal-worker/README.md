# Sal worker skills and memory on Harbour

A Sal worker's skills and memory composed from Harbour's packages, and a harness that checks a Harbour Sal worker is
given what a local Sal worker is given for the same task (issue #12).

- `src/okf.ts`: Sal's memory bundle (OKF v0.2 concept files in tvdavies/sal-memory) as a `MemorySnapshot`. Status,
  scope, job exceptions, the `profile` tag and `learned_from` are read the way Sal's `summarise` reads them; what
  Harbour has no field for is kept in the `sal` extension.
- `src/skill-sources.ts`: skill sources pinned per ref. A Git repository at a commit (Tom's agent-toolkit, Sal's own
  skills) or a directory pinned by a digest of its contents (skills installed without Git). Skills are found and
  described as Pi finds them: a `SKILL.md` with YAML frontmatter and a description. Binary files are left out (a
  `SkillFile` is text) and recorded in the revision's `sal.binaryLeftOut`.
- `src/recall-renderer.ts`: a `RecallRenderer` that renders `<memory_recall>` exactly as a Sal worker receives it.
  Budgets count rendered bytes, so the same renderer gives the same selection.
- `src/worker.ts`: `prepareSalWorker` imports the bundle and publishes the skills, each at its pinned ref, with Sal's
  worker exclusions. `startSalWorkerSession` pins a session's skills and returns its listing, Pi's prompt block and
  its recall. `host.skillsMount` serves the pinned packages read-only at `/skills`.

## Parity with a local Sal

`scripts/sal-local.ts` runs under Bun against an installed Sal release. It calls Sal's own `planPiSetup` and
`assembleLaunchContext` for the worker role with a pinned sal-memory clone, and reads only. `scripts/harbour-sal.ts`
runs the Harbour side from a config file. `scripts/parity.ts` compares recalled concepts and reasons, the recall
text byte for byte, skipped concepts, the skill set, each skill's `SKILL.md` and whole package digest, and Pi's
`<available_skills>` block. Locations are ignored because Harbour mounts skills at `/skills`.

```sh
# per task: what the local Sal worker gets
bun examples/sal-worker/scripts/sal-local.ts --sal ~/.local/share/sal/current --config ~/.config/sal/sal.json \
  --memory <sal-memory clone> --task TASK-1 --brief <BRIEF.md> --workspace <task workspace> --now 2026-10-27T20:00:00Z > sal-TASK-1.json
# all tasks: what a Harbour Sal worker gets
node examples/sal-worker/scripts/harbour-sal.ts --config parity.json > harbour.json
node examples/sal-worker/scripts/parity.ts --harbour harbour.json --sal TASK-1=sal-TASK-1.json
```

`parity.json` names the memory clone and commit, the skill sources in Pi's order and the tasks; see the header of
`scripts/harbour-sal.ts`. On 27 October 2026 the harness ran five real Sal worker briefs. The pins were sal-memory
`7fbf30f6`, agent-toolkit `556e4213`, Sal's skills `8d48d2a0`, and directory digests for `~/.pi/agent/skills`, the
synced Claude skills and the pi-subagents package. All five tasks matched with no differences: 41 profile concepts
plus 4 matches each, recall text of 27,811 to 28,128 bytes, and 64 skills. A control run with the older sal-memory
commit and one fewer exclusion was flagged on every task.

## Known differences and gaps

- Pi does not load a skill whose frontmatter is not valid YAML (agent-toolkit's `brwsr-browse` at `556e4213`), but
  Sal's launch manifest still lists it. Harbour follows Pi, so the worker never sees it. The harness reports it as
  `notLoaded`.
- Grants can bring an excluded skill back for one task (Sal's `withGrantedSkills`). Harbour publishes one set per
  owner, so a per-task exclusion would need a per-session visibility. None of the five tasks had such a grant.
- Sal's `deprecated` concepts become `forgotten`. They stay inactive, but a skip reason reads `forgotten`, not
  `deprecated`.
- Sal reranks recall with a model only in conversations. Workers use BM25 alone, as here.
