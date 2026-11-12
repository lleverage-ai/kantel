---
title: GitHub Actions runners
description: Run GitHub Actions jobs on your own hosts, one throwaway microVM per job. Connect a GitHub App, name pools by their runs-on label, and Kantel makes a runner for each queued job, waits for room when the hosts are full, and deletes the runner when its job ends.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
GitHub runners are off unless the deployment turns them on with `KANTEL_GITHUB_RUNNERS=experimental`. They make their microVMs from [templates](#the-runner-template), so they need `KANTEL_TEMPLATES=experimental` too, and a secrets key (`KANTEL_SECRETS_KEY`), as the App's private key is kept encrypted. Their shapes may still change.
:::

Kantel can run your GitHub Actions jobs the way hosted runner services do. You connect a GitHub App to an organisation in Kantel and give it pools, each with a `runs-on` label, a template and a shape. When a workflow job with a pool's label is queued, Kantel makes a microVM for it on the organisation's hosts, registers a just-in-time runner in it, and deletes the microVM when the job ends. Every job starts on a clean machine, and the hosts are shared with whatever else the organisation runs on Kantel.

```yaml
jobs:
  checks:
    runs-on: kantel-8vcpu
```

## How a job gets a runner

1. GitHub sends the App's webhook a `workflow_job` event, `queued`. Kantel checks its signature and records the job if a pool takes it: its labels include the pool's label, and every one of its labels is one the runner has (the pool's label, `self-hosted`, `linux` and `x64`).
2. Kantel makes a microVM from the pool's template, with the pool's vCPUs, memory and disk, on a host it may use.
3. When the microVM runs, Kantel asks GitHub for a [just-in-time runner](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-an-organization) named after the sandbox, and starts it with that configuration in `KANTEL_RUNNER_JITCONFIG`. The runner takes one job and exits.
4. GitHub gives the runner a job with those labels. It isn't always the job that called it up: any runner may take any job its labels match. Kantel counts runners against each pool's queue, so the numbers work out.
5. When GitHub reports the job `completed`, Kantel deletes the runner's microVM. A runner that no job came for is removed from GitHub and deleted after two minutes with nothing queued for its pool.

A runner is deleted after the pool's `timeoutMinutes` (360 by default), whatever it is doing. If GitHub's `completed` webhook goes missing, Kantel asks GitHub about each busy runner's job every five minutes. Webhooks may come in any order: a job only ever moves forward, from queued to in progress to completed.

A runner is forgotten only once its sandbox has gone and GitHub no longer has it registered. If either can't be done (a host or GitHub is away), Kantel tries again on its next pass, for up to a day. With several control plane replicas, one at a time runs an integration's pass.

## When there's no room

GitHub sends a job's `queued` webhook once, and keeps the job waiting for up to a day. Kantel keeps its own queue, so a job is never dropped for lack of room:

- When no host has the memory or disk for a runner, or the organisation is at a limit, the job stays queued. The pool waits 20 seconds before it tries again, then tries one runner at a time until one fits, and the rest follow.
- When one of the pool's runners is deleted, the pool tries again straight away.
- A pool never has more runners than its `maxRunners` (20 by default), starting or running. Jobs beyond that wait their turn.
- Jobs wait in the order they were queued.

`GET /v1/github-runners/{id}` answers each pool's queue: how many jobs are queued, how many runners are starting, idle or busy, when the oldest queued job was queued, and why it is still waiting.

## Where runners go

Runners go on the organisation's own hosts, and on the deployment's shared hosts if it may use them, like any other sandbox. A pool's `hostLabels` keeps them to hosts with those labels.

Kantel places each microVM on the host that will be least full once it is there. It compares the share of each host's memory in use with the share of its vCPUs booked by running microVMs, and takes the larger. That spreads runners over hosts of different sizes in proportion, and a host whose CPUs are booked by a few large sandboxes isn't picked just because it has memory left. A host admits a microVM by memory and disk only. Booked vCPUs are shares of CPU time, not cores of their own, so a host may be booked past its CPUs.

## Set it up

### 1. Make a GitHub App

Make an App on your GitHub organisation (**Settings > Developer settings > GitHub Apps > New GitHub App**):

- **Webhook**: on. Leave the URL and secret for now; Kantel gives you both in step 3.
- **Permissions**: Organization **Self-hosted runners**: read and write. Repository **Actions**: read-only, so Kantel can check a job whose `completed` webhook went missing.
- **Subscribe to events**: **Workflow job**.

Make a private key on the App's page, and install the App on the organisation, for the repositories that will use it.

### 2. Make a runner group

Make a runner group on the organisation (**Settings > Actions > Runner groups**) and limit it to the repositories that should use Kantel's runners. Note its ID: it's in the group's URL, and `gh api orgs/<org>/actions/runner-groups` lists it. Don't let a public repository use the group: anyone could open a pull request that runs on your hosts.

### 3. Connect it to Kantel

```sh
curl -X POST https://<your-kantel>/v1/github-runners \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d @- <<EOF
{
  "account": "<organisation id>",
  "name": "ci",
  "appId": 123456,
  "privateKey": $(jq -Rs . < app.private-key.pem),
  "owner": "<github org>",
  "runnerGroupId": 3,
  "repositories": ["<github org>/<repo>"],
  "pools": [
    {
      "label": "kantel-8vcpu",
      "template": "github-runner",
      "resources": { "vcpus": 8, "memoryMb": 24576, "diskGb": 100 },
      "maxRunners": 10
    }
  ]
}
EOF
```

It answers the integration, with its `webhookUrl`, and the `webhookSecret`, which is shown once. Put both on the App's webhook settings. GitHub sends a `ping` straight away; Kantel answers it.

It needs an organisation admin (a key with `account:admin`). It makes an API key of its own, named **GitHub runners: ci**, with the scopes runners need (`sandboxes:read`, `sandboxes:write`, `sandboxes:delete` and `exec`). The runners are that key's sandboxes, so they show in the console as made by it. Revoke the key and the integration makes no more runners, and ends the ones it has.

Deleting the integration (`DELETE /v1/github-runners/{id}`) revokes its key, deletes its runners' sandboxes and takes their runners off GitHub. It is hidden at once and kept until every runner has gone, so a host or GitHub that is away doesn't leave one behind.

`scope` is `organization` by default, which needs `runnerGroupId`. With `repository`, runners are registered on each job's repository instead, and the App needs the repository **Administration** permission (read and write).

### 4. Use it

Change a job's `runs-on` to the pool's label. `GET /v1/github-runners/{id}/jobs` lists the jobs the webhook told Kantel of, newest first, with the sandbox that ran each.

## The runner template

A pool's template must have the [Actions runner](https://github.com/actions/runner) in it. Kantel starts it as the sandbox's default user, `user`, which has passwordless `sudo` on Kantel's images. A sandbox reaches the internet only through its egress proxy, named in `HTTPS_PROXY` and the other proxy variables, so a command that switches user must keep them, or the runner can't reach GitHub. By default it runs:

```sh
sudo -n --preserve-env=HTTP_PROXY,HTTPS_PROXY,NO_PROXY,http_proxy,https_proxy,no_proxy,NODE_USE_ENV_PROXY \
  runuser -u runner -- /home/runner/actions-runner/run.sh --jitconfig "$KANTEL_RUNNER_JITCONFIG"
```

Give the pool a `runnerCommand` to start it another way. A template like this one runs it on Kantel's default image, which has Docker:

```json
{
  "name": "github-runner",
  "spec": {
    "resources": { "vcpus": 8, "memoryMb": 24576, "diskGb": 100 },
    "setup": "set -eux\nexport DEBIAN_FRONTEND=noninteractive\napt-get update -qq\napt-get install -y -qq --no-install-recommends ca-certificates curl git jq openssl unzip python3 python3-venv rsync sudo\nid runner || useradd -m -s /bin/bash runner\nusermod -aG docker runner\necho 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner\nV=2.338.2\nmkdir -p /home/runner/actions-runner\ncurl -fsSL https://github.com/actions/runner/releases/download/v$V/actions-runner-linux-x64-$V.tar.gz | tar -xz -C /home/runner/actions-runner\n/home/runner/actions-runner/bin/installdependencies.sh\nchown -R runner:runner /home/runner"
  }
}
```

Anything a job would download every time, such as its toolchain, Docker images or a dependency store, can go in the template's setup instead. For caches that change with every merge, a [sticky disk](/sandboxes/sticky-disks/) suits better:

```json
"stickyDisks": [{
  "disk": "ci-cache",
  "path": "/var/lib/ci",
  "commit": { "branches": ["main"], "beforeCommit": "pnpm store prune; systemctl stop docker" }
}]
```

Each runner gets a copy of the disk's newest version. After a job that succeeds, Kantel checks with GitHub that the job ran on that very runner (by GitHub's runner ID, not its name) and asks about its run. It commits the runner's copy only when the run is a scheduled run of one of `branches` in the job's own repository. GitHub runs scheduled workflows only on the default branch, so name that branch, and warm the cache from a workflow with an `on: schedule` trigger, hourly say.

Push and manual (`workflow_dispatch`) runs don't commit for now. GitHub gives a tag's run the tag's name where a branch's run has the branch's, and says nothing on the run or its jobs that tells the two apart, so a tag called `main` would pass for the branch. A pull request's jobs never commit, whatever their branch is called.

`beforeCommit` runs first, as root, whatever the image's default user; if it fails, nothing is committed. The integration's key needs `snapshots:write` to commit: Kantel gives it that when a pool first commits, so the person or key changing the pools must be able to grant it. Every runner starts from the template's snapshot, so it starts with all of it. Rebuild the template to bring it up to date.

## Turn it on (operators)

| Setting | What |
| --- | --- |
| `KANTEL_GITHUB_RUNNERS` | `experimental` turns the routes and the broker on. Unset or `off`: off, and `/v1/github-runners` answers `not_supported` |
| `KANTEL_TEMPLATES` | `experimental`: pools make their runners from templates |
| `KANTEL_SECRETS_KEY` | Seals the App's private key and the webhook's secret |

The webhook URL is under the control plane's public URL, so GitHub must reach it. A self-hosted control plane runs the broker in its compute sweep, every five seconds. The hosted service runs it on its alarm while jobs are queued or runners are starting, and once a minute otherwise.

<!-- Sources: packages/compute/src/github-runners.ts, packages/compute/src/github-app.ts, packages/compute/src/service.ts (createGithubRunners, githubWebhook, tickGithubRunners), packages/compute/src/http.ts (GITHUB_WEBHOOK), packages/hosts/src/scheduler.ts (fullness), packages/api/src/compute-routes.ts (githubRunnerRoutes), apps/cloudflare/src/stack-object.ts (alarm) -->
