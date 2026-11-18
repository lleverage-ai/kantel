# Releases

A Kantel release is one version of everything, on the GitHub Release `v<version>`:

| What | From | How people get it |
| --- | --- | --- |
| `kantel-<os>-<arch>`, the user CLI and MCP server, for `linux` and `darwin` on `amd64` and `arm64` | `apps/cli/cmd/kantel` | `install-cli.sh` installs it as `kantel`; `kantel update` updates it |
| `kantel-admin-<os>-<arch>`, the operator CLI, for the same four | `apps/cli/cmd/kantel-admin` | `install-cli.sh --admin` installs it as `kantel-admin`, or `curl -fsSLo kantel-admin …/releases/latest/download/kantel-admin-linux-amd64` |
| `install-cli.sh`, the CLIs' installer | `apps/cli/install-cli.sh` | `curl -fsSL https://kantel.dev/cli.sh \| sh` (kantel.dev serves the repository's copy, unstamped, which installs the latest release), or this release's own stamped copy |
| `kantel-host-linux-amd64`, `kantel-host-linux-arm64`, the host agent | `apps/host` | `install.sh` downloads it |
| `install.sh`, the host installer | `apps/host/install.sh` | the join command: `curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh \| sudo sh -s -- --url … --token kth_…` |
| `SHA256SUMS` | | both installers check what they download against it |

Both one-liners work pasted into bash, zsh and fish: the scripts run under `sh`.

Every binary is a static Go one (`CGO_ENABLED=0`, `-trimpath`, `-s -w`), so nothing else needs installing: no
Node.js, no libc of a particular version. Each has the release's version stamped in with `-X`:
`apps/cli/internal/kantel.Version` for `kantel`, `apps/cli/internal/admin.Version` for `kantel-admin`, and
`main.version` for `kantel-host`. Until `apps/cli/cmd/kantel-admin` is there, `pack.sh` skips it with a note and the
release has no `kantel-admin`.

`install-cli.sh` needs no sudo: it picks the binary for the machine (`uname`: Linux or macOS, x86_64 or arm64; arm64
on an Apple silicon Mac under Rosetta), checks it against `SHA256SUMS` and that it runs, and puts it in
`~/.local/bin` (`KANTEL_BIN_DIR`, or `--dir DIR`), beside the old one and renamed over it. It says how to put that
directory on the `PATH` in fish, bash and zsh. An update keeps a `kantel-admin` it installed before unless given
`--no-admin`, and `--version V` installs a release other than the script's own. It replaces an install by a Node.js
release (a link to `~/.local/share/kantel/kantel.mjs`), but not a file or link it didn't put there. Run it again, or
`kantel update`, to update.

`kantel update` does the same from the binary itself: it finds the latest release where `releases/latest` redirects
(or takes `--version`), downloads `kantel-<os>-<arch>` and `SHA256SUMS`, checks the one against the other and that it
runs and prints the version, and renames it over the running binary (its links resolved), and over `kantel-admin`
when that is in the same directory. After a command, `kantel` prints one line on stderr when a newer release is out,
asking GitHub at most once a day (`~/.cache/kantel/update-check.json`), never for a script, CI or a coding agent.
`KANTEL_RELEASE_URL`, a directory holding a release's files, points the installer, `kantel update` and the notice at
a mirror (`smoke.sh` uses `file://`); `kantel` reads which release it holds from its stamped `install-cli.sh`.

npm publishing is off. The npm package `kantel` was the Node.js CLI; the CLI is a Go binary now, so `pack.sh` builds
no npm package, and the workflow's `dry-run` and `publish` jobs (`publish.sh`, left as it was) are switched off with
`if: false` until there is an npm package for the binaries.

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

It builds everything (`pack.sh`) and checks it (`smoke.sh`: every command prints the version, the macOS binaries are
Mach-O, `SHA256SUMS` matches, `install.sh` installs a good binary and refuses a bad one, `install-cli.sh` installs
`kantel` for a user, adds `kantel-admin` with `--admin`, updates both, replaces a Node.js release's install and refuses
a bad binary, and `kantel update` replaces itself from the release's files and refuses a bad binary). Then it attests
the release's files and makes the GitHub Release `v<version>` at the run's commit (`github-release.sh`), with every
file `SHA256SUMS` lists.

- A version without a prerelease part (`0.1.0`) becomes the **latest** GitHub Release, which the join command
  Kantel prints (`releases/latest/download/install.sh`) and `releases/latest/download/install-cli.sh` install.
- A prerelease (`0.2.0-rc.1`) is a GitHub prerelease, never the latest, so neither `kantel update` nor its notice
  offers it; `kantel update --version 0.2.0-rc.1` installs it. Try it on a host with
  `curl -fsSL https://github.com/lleverage-ai/kantel/releases/download/v0.2.0-rc.1/install.sh | sudo sh -s -- --url … --token …`.
- A run that stopped part way can be run again with the same version: a complete GitHub Release is skipped.
- Without `-f publish=true` it stops after printing the GitHub Release it would make, which is also what it does on a
  pull request that touches what it releases.

## Telling the control plane

After the GitHub Release, `check-control-plane.sh` asks app.kantel.dev (the repository variable `KANTEL_PUBLIC_URL`,
or `https://app.kantel.dev`) to read the latest release now: `POST /v1/hosts/releases/check`, with the
`KANTEL_RELEASE_CHECK_TOKEN` Actions secret as its bearer. The console then offers hosts the update within a minute,
rather than within the hour. The call names no version: the control plane reads GitHub's latest release itself, so
the token can only make it read sooner. The script first waits (up to two minutes, network time included) for
`releases/latest` to name the new tag, then tries three times, 35 seconds apart, past the control plane's
30-second gap between checks.

It never fails a release. Without the secret, for a prerelease, or when the control plane refuses or can't be
reached, it prints a warning, and the control plane still reads the release within the hour. A super-admin's
**Check for updates** on the Hosts page does the same check by hand.

The token is a shared secret, in two places: the Worker secret `KANTEL_RELEASE_CHECK_TOKEN` on the hosted control
plane and the repository's Actions secret of the same name. Make it with `openssl rand -hex 32` and set both to the
same value; to change it, set both again. A self-hosted control plane takes the same setting (in `.env` on the
Docker Compose stack). Check it from a shell holding the token:

```sh
KANTEL_RELEASE_CHECK_TOKEN=… tools/release/check-control-plane.sh 0.3.1
```

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
gh attestation verify ~/.local/bin/kantel --repo lleverage-ai/kantel   # an installed kantel
```

## Locally

```sh
tools/release/pack.sh 0.1.0 /tmp/release
tools/release/smoke.sh 0.1.0 /tmp/release
tools/release/github-release.sh --dry-run 0.1.0 /tmp/release
```

`pack.sh` needs Go (the version in `apps/cli/go.mod`, which `apps/host/go.mod` matches), GNU find and `sha256sum`,
and leaves the repository as it found it; it takes about half a minute for every platform. `smoke.sh` runs on Linux,
x86_64 or arm64, as a user other than root.

## The first `kantel` version on npm (for if publishing is turned on again)

npm only lets a trusted publisher be added to a package that already exists. `kantel`'s first version is a
placeholder (`0.0.0-bootstrap.0`, under the `bootstrap` dist-tag) published by a maintainer, who then adds the
trusted publisher with npm 11.15 or later:

```sh
npm trust github kantel --repo lleverage-ai/kantel --file release.yml --env npm --allow-publish --yes
```

A trusted publisher that hasn't published within two days expires, so run the workflow soon after.
