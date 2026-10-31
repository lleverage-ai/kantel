---
title: Schedules
description: Run an agent task or a check on a timetable, see when it runs next, pause, resume or end it, and read its run history.
---

A schedule runs something on its own, once or on a timetable: a task that asks an agent to do something in a new
session, or a check that runs a command with no model.

:::note[Not yet available]
Schedules run on Cloudflare deployments only. The self-hosted gateway serves no schedule routes and runs no
scheduler yet.
:::

## Kinds

A schedule has one of six kinds. On Cloudflare two of them run:

| Kind | What a run does |
| --- | --- |
| Task | Starts a new session with an agent and sends it your prompt as its first message, exactly as written. Kantel adds no text of its own. |
| Check | Runs a command in the isolate sandbox, with no model. Exit 0 is healthy, exit 3 reports findings as JSON, and anything else fails the run. |

The other kinds (reminder, summary, heartbeat and program) can be stored, but nothing runs them yet: each of their
runs fails, saying the kind has no handler.

### Tasks

A task's run starts a session in the schedule's project (for one owned by the organisation or a person, the
deployment's default project unless the task names one). The session is labelled `harbour.schedule` and
`harbour.occurrence` and is listed in the console like any other. The run counts as done once the session has its
prompt.

### Checks

A check's command runs in the isolate tier in the check's own workspace (`check_<scheduleId>`), kept between runs.
Each run has its own session, titled after the check and closed when the command ends. A command may run for up to
60 seconds.

A check raises a finding when it is new, when it got worse, when its value has grown (by 2 times by default), or when
it is still there after a quiet period (6 hours by default). After 3 failed runs in a row (by default) it raises a
low-severity `check-failed` finding. Each raised finding is audited as `schedules.finding.raised`.

:::note[Not yet available]
Cloudflare has no container tier yet, so a check whose command needs it (`git`, `node`, `python` and other container
commands) fails its run. The console can't show a check's findings yet either, only how many each run found.
:::

## Timing

A schedule runs once at a set time, or repeats:

| Repeats | How it counts |
| --- | --- |
| Every *n* minutes or hours | Absolute intervals. Every 6 hours stays 6 hours apart across a clock change. |
| Every *n* days, weekdays, chosen days of the week, or a day of the month | At a local time (`HH:MM`) in the schedule's time zone. Day 31 means the last day of the month. |

Every schedule has an IANA time zone, such as `Europe/London`. A daily 09:00 London schedule runs at 08:00 UTC in
summer and 09:00 UTC in winter. A local time that a clock change skips runs at the first valid moment after it; a
time that happens twice runs once, the first time.

A repeating schedule can stop after a number of runs, or after a date. A one-off ends after it runs.

### Missed and repeated runs

- Runs never overlap, and missed runs are combined into one at the latest due time.
- A paused schedule creates no runs, and resuming it doesn't catch up on the paused time.
- A run that is cut off runs again as a second attempt. A retried task finds the session it started rather than
  starting another.
- A task's run may take up to 2 hours; other kinds 10 minutes.

## The schedules page

The schedules page is at `/schedules`; a schedule opens at `/schedules/<scheduleId>`. It reads "What runs on its own:
reminders, tasks, summaries, checks and programs, with when each runs next."

**Show** filters the list: Active, Paused, Ended or All.

Picking a schedule shows:

- Its kind and status, with **Edit** (tasks and checks) and **Pause** or **Resume**.
- **When it runs**: how it repeats, the time zone, any limits, the owner, who created it and when, and how many runs
  so far. For a check, **Raises again** shows its finding settings. While it is active, the next due times are listed
  in the schedule's time zone.
- **Prompt**, for a task: which agent it asks, "in a new session each run", and the prompt as written. For a check,
  the command.
- **Run history**, newest first: Due, Running, Succeeded or Failed, or for a check Healthy, a number of findings, or
  "Findings, none new". **Problems** shows only failed runs and findings. A run that started a session has
  **Open session**.

### Create a schedule

**New schedule** (or `/schedules/new`) is shown when you have the operator role on a project and there is an agent
profile to ask. The schedule belongs to the first project, by name, that you may operate in. The form creates tasks
and checks only.

1. **Kind**: Task or Check.
2. **Title**.
3. For a task, pick the **Agent** and write the **Prompt**. Each run starts a new session and sends the prompt as
   its first message. For a check, enter the **Command**: a script and its arguments.
4. **When**: Repeats or Once.
   - Once: pick the **Date and time**.
   - Repeats: pick **Every** (Minutes, Hours, Days, Weekday, "Week, on chosen days" or "Month, on a day"), then the
     interval, **Day of the month**, **At** or the days under **On**, as the choice needs. **Stop after** limits the
     number of runs; leave it empty for no limit.
5. **Time zone**.
6. For a check, under "When findings are raised again", set **Raise again after** (hours), **Rising by** and
   **Failures before raising**.
7. Check **Next runs**, then choose **Create schedule**.

Changing a project's schedule needs the operator role on the project; reading it needs the viewer role. Agents can't
create or change schedules.

### Edit, pause, resume and end

- **Edit** opens the form with **Save changes**. You can't change a schedule's kind.
- **Pause** stops new runs until you choose **Resume**.
- **End schedule** (in the edit form) asks you to confirm: nothing more runs, and the schedule stays listed as ended,
  with its run history. This can't be undone. **Keep it** cancels.

## Schedules in the API

| Route | What it does |
| --- | --- |
| `GET /v1/schedules`, `POST /v1/schedules` | List or create schedules. |
| `GET`, `PATCH`, `DELETE /v1/schedules/{scheduleId}` | Read, change or end a schedule. `PATCH` takes `null` to clear `at`, `repeat`, `until` or `count`. |
| `POST /v1/schedules/{scheduleId}/pause`, `/resume` | Pause or resume. |
| `GET /v1/schedules/{scheduleId}/preview?n=` | The next due times (5 by default). |
| `GET /v1/schedules/{scheduleId}/runs` | Run history. |

Give exactly one of `at` (a one-off, in epoch milliseconds) and `repeat`.

```ts
import { createKantelClient } from "@kantel/api/sdk";

const kantel = createKantelClient({
  baseUrl: `${process.env.KANTEL_URL}/v1`,
  token: process.env.KANTEL_API_KEY,
});

const schedule = await kantel.createSchedule({
  owner: { kind: "project", organisationId: "org_…", projectId: "prj_…" },
  kind: "task",
  title: "Triage new issues",
  timezone: "Europe/London",
  repeat: { every: "weekday", at: "09:00" },
  payload: { agentId: "<agentId>", prompt: "Triage the issues opened since yesterday." },
});
```

```sh
curl -s "$KANTEL_URL/v1/schedules" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"owner":{"kind":"project","organisationId":"org_…","projectId":"prj_…"},"kind":"task","title":"Triage new issues","timezone":"Europe/London","repeat":{"every":"weekday","at":"09:00"},"payload":{"agentId":"<agentId>","prompt":"Triage the issues opened since yesterday."}}'
```

Package names still use the old name, `harbour`. See the [API reference](/api/reference/).

<!-- Sources (8584d5b): packages/schedules/CONTRACT.md:1-90, packages/schedules/CONTRACT.md:124-162, packages/contracts/src/schedules.ts:17-47, apps/cloudflare/src/schedules.ts:1-14, apps/cloudflare/src/schedule-checks.ts:1-22, apps/cloudflare/README.md:24-40, apps/selfhosted/src/gateway/gateway.ts:7-27, apps/console/src/api/schedules-http.ts:48-72, apps/console/src/api/schedules-http.ts:93-116, apps/console/src/app/schedules-screen.tsx:1-35, apps/console/src/app/router.ts:97-102, apps/console/src/main.tsx:68-70, packages/ui/src/schedules/schedules-page.tsx:150-640, packages/ui/src/schedules/schedules-model.ts:110-120, packages/ui/src/schedules/schedules-model.ts:240-262, packages/ui/src/schedules/schedules-model.ts:330-391, packages/ui/src/schedules/form/schedule-form.tsx:55-120, packages/ui/src/schedules/form/schedule-form.tsx:228-370, packages/ui/src/schedules/form/schedule-form.tsx:370-620, packages/ui/src/schedules/form/schedule-form.tsx:625-667, packages/api/src/routes.ts:522-546, packages/api/generated/sdk.ts:482-500, packages/api/generated/sdk.ts:1094-1097 -->
