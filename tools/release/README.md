# Releases

A Kantel release is one version of everything, on the GitHub Release `v<version>`:

| What | From | How people get it |
| --- | --- | --- |
| `kantel.js`, the user CLI and MCP server (Node.js 22+) | `packages/cli` | `install-cli.sh` installs it as `kantel` |
| `kantel-admin.js`, the operator CLI (Node.js 22+) | `packages/admin` | `install-cli.sh` installs it as `kantel-admin`, or `curl -fsSLo kantel-admin …/releases/latest/download/kantel-admin.js` |
| `install-cli.sh`, the CLIs' installer | `packages/cli/install-cli.sh` | `curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install-cli.sh \| sh` |
| `kantel-host-linux-amd64`, `kantel-host-linux-arm64`, the host agent | `apps/host` | `install.sh` downloads it |
| `install.sh`, the host installer | `apps/host/install.sh` | the join command: `curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh \| sudo sh -s -- --url … --token kth_…` |
| `SHA256SUMS` | | both installers check what they download against it |

Both one-liners work pasted into bash, zsh and fish: the scripts run under `sh`.

`install-cli.sh` needs no sudo: it puts the files in `~/.local/share/kantel` (`KANTEL_HOME`) as `kantel.mjs` and
`kantel-admin.mjs`, so Node runs them as ES modules whatever is around them, and links `~/.local/bin/kantel` and
`~/.local/bin/kantel-admin` to them. `sh -s -- --dir DIR` links them elsewhere, `--no-admin` skips `kantel-admin`,
and `--version V` installs a release other than the script's own. Run it again to update.

`kantel` is also built as the npm package `kantel`, and the workflow can publish it, but that is on hold until Kantel
is ready for it: it runs only with `-f publish_npm=true`.

## Why the self-hosting side isn't on npm

`kantel` may go on npm one day, for everyone who uses sandboxes from any machine with Node.js. The rest is for the
few who run Kantel themselves, on Linux servers, as root:

- `kantel-host` is a Go binary. On npm it needed a launcher package and one package per platform, and a host needed
  Node.js only to run `npx`. A release file and a shell script need nothing but `curl`.
- The `@kantel` npm scope belongs to someone else, so the operator packages couldn't have had the names they were
  built under, and another scope would have split Kantel's names in two.
- A host installs a system service from what it downloads, so it should check what it got: `install.sh` checks the
  binary against the release's `SHA256SUMS`, and every release file has a GitHub build provenance attestation, as
  npm provenance gives `kantel`.

## Releasing

Run the [Release workflow](../../.github/workflows/release.yml) on main with a version:

```sh
gh workflow run release.yml --repo lleverage-ai/kantel --ref main -f version=0.1.0 -f publish=true
```

It builds everything (`pack.sh`) and checks it (`smoke.sh`: every command prints the version, `SHA256SUMS` matches,
`install.sh` installs a good binary and refuses a bad one, and `install-cli.sh` installs both CLIs for a user, updates
them, and refuses a bad file or an old Node.js). Then it attests the release's files and makes the GitHub Release
`v<version>` at the run's commit (`github-release.sh`). With `-f publish_npm=true` as well, it then publishes `kantel`
to npm (`publish.sh`).

- A version without a prerelease part (`0.1.0`) becomes the **latest** GitHub Release, which the join command
  Kantel prints (`releases/latest/download/install.sh`) and `releases/latest/download/install-cli.sh` install.
- A prerelease (`0.2.0-rc.1`) is a GitHub prerelease, never the latest (and npm's `next`). Try it on a host with
  `curl -fsSL https://github.com/lleverage-ai/kantel/releases/download/v0.2.0-rc.1/install.sh | sudo sh -s -- --url … --token …`.
- A run that stopped part way can be run again with the same version: a complete GitHub Release and a version
  already on npm are skipped.
- Without `-f publish=true` it stops after printing the GitHub Release it would make and `npm publish --dry-run`,
  which is also what it does on a pull request that touches what it releases.

The host images (`host-images-*` releases, from `apps/host/guest/release.sh`) are separate, and never the latest
release, so they don't move `releases/latest`.

When npm publishing is turned on, there is no npm token. The workflow uses npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers):
`kantel` trusts `lleverage-ai/kantel`'s `release.yml` in the `npm` GitHub environment, which only main may deploy
to, and npm adds provenance to every version. Trusted publishing only works on GitHub-hosted runners, so this
workflow doesn't use Kantel's self-hosted ones. The GitHub Release uses the workflow's own token.

## Checking a release

```sh
curl -fsSLO https://github.com/lleverage-ai/kantel/releases/download/v0.1.0/kantel-host-linux-amd64
curl -fsSLO https://github.com/lleverage-ai/kantel/releases/download/v0.1.0/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify kantel-host-linux-amd64 --repo lleverage-ai/kantel
npm audit signatures   # in a project that installed kantel: checks its provenance
```

## Locally

```sh
pnpm install --filter "@kantel/admin..."
tools/release/pack.sh 0.1.0 /tmp/release
tools/release/smoke.sh 0.1.0 /tmp/release
tools/release/github-release.sh --dry-run 0.1.0 /tmp/release
tools/release/publish.sh --dry-run /tmp/release
```

`pack.sh` needs Go (the version in `apps/host/go.mod`) and leaves the repository as it found it.

## The first `kantel` version on npm (for when publishing is turned on)

npm only lets a trusted publisher be added to a package that already exists. `kantel`'s first version is a
placeholder (`0.0.0-bootstrap.0`, under the `bootstrap` dist-tag) published by a maintainer, who then adds the
trusted publisher with npm 11.15 or later:

```sh
npm trust github kantel --repo lleverage-ai/kantel --file release.yml --env npm --allow-publish --yes
```

A trusted publisher that hasn't published within two days expires, so run the workflow soon after.
