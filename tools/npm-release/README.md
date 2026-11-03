# npm releases

Kantel publishes five npm packages, all at one version:

| Package | From | What it is |
| --- | --- | --- |
| `@kantel/host-linux-x64`, `@kantel/host-linux-arm64` | `apps/host/npm/platform` | the `kantel-host` binary for each platform |
| `@kantel/host` | `apps/host/npm/host` | the launcher, `sudo npx -y @kantel/host@latest install …`; picks the platform package |
| `@kantel/admin` | `packages/admin` | the operator CLI, `npx @kantel/admin host join …` |
| `kantel` | `packages/cli` | the user CLI and MCP server, `npx kantel …` |

## Releasing

Run the [Release workflow](../../.github/workflows/release.yml) on main with a version:

```sh
gh workflow run release.yml --repo lleverage-ai/kantel --ref main -f version=0.1.0 -f publish=true
```

It builds and packs every package (`pack.sh`), checks that each tarball's command prints the version (`smoke.sh`)
and publishes them in order, platforms first (`publish.sh`). A version with a prerelease part (`0.2.0-rc.1`) goes out
under the `next` dist-tag, anything else as `latest`. A version already on npm is skipped, so a run that stopped part
way can be run again with the same version. Without `-f publish=true` it stops at `npm publish --dry-run`, which is
also what it does on a pull request that touches the packages.

There is no npm token. The workflow uses npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers): each
package trusts `lleverage-ai/kantel`'s `release.yml` in the `npm` GitHub environment, which only main may deploy to,
and npm adds provenance to every version. Trusted publishing only works on GitHub-hosted runners, so this workflow
doesn't use Kantel's self-hosted ones.

## Locally

```sh
pnpm install --filter "@kantel/admin..."
tools/npm-release/pack.sh 0.1.0 /tmp/npm-release
tools/npm-release/smoke.sh 0.1.0 /tmp/npm-release
tools/npm-release/publish.sh --dry-run /tmp/npm-release
```

`pack.sh` needs Go (the version in `apps/host/go.mod`) and leaves the repository as it found it.

## A new package

npm only lets a trusted publisher be added to a package that already exists. A new package's first version is a
placeholder (`0.0.0-bootstrap.0`, under the `bootstrap` dist-tag) published by a maintainer, who then adds the
trusted publisher with npm 11.15 or later:

```sh
npm trust github <package> --repo lleverage-ai/kantel --file release.yml --env npm --allow-publish --yes
```

A trusted publisher that hasn't published within two days expires, so run the workflow soon after.
