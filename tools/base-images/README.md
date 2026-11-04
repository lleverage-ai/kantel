# tools/base-images

The command line of Kantel's base image pipeline (`.github/workflows/sandbox-image.yml`): two small scripts over the
index's shared module, `packages/compute/src/base-images.ts`, so CI writes the index with the same functions the
gateway reads it with. They run with Node 24's type stripping (`node tools/base-images/<script>.ts`) and import nothing
beyond Node's own modules and that module.

## The index

One JSON document of the images Kantel builds, what each one's `stable` channel names, and what the scans found:

<https://github.com/lleverage-ai/kantel/releases/download/base-images/index.json>

It is an asset of the rolling `base-images` release, a prerelease that is never the latest, with its Sigstore bundle
`index.json.sigstore.json` beside it. For each image (`sandbox`, `browser`, `isolate-host`, and `host` for the microVM
host images):

- `repository`: where it pulls from, such as `ghcr.io/lleverage-ai/kantel-sandbox`; for `host`, the download URL of
  its `host-images-<yyyymmdd>.<n>` release.
- `channels`: `{"stable": "sha256:…"}`, the digest a host should run.
- `versions`: the newest 30 builds, newest first, each with its version (`2026.11.04.812`), digest, build time, commit,
  reason (`daily`, `cve` or `manual`), whether it is signed, and its newest scan: counts by severity, how many Critical
  and High findings have a fix out, and up to 50 Critical and High findings.

A version never changes: its digest is fixed, and `stable` moves by naming another one. `stable` never moves to a
build with more fixable Critical findings than the one it names, so a bad day's build doesn't regress it.

## How CI uses them

- Each build is scanned with Trivy before it is pushed. `scan.ts <trivy.json>` prints the summary the index records
  and adds a table of the findings to the job summary; `scan.ts <trivy.json> --needs-rebuild` exits 3 when a Critical
  or High finding has a fix out, and the workflow then rebuilds the image once straight away.
- `index.ts build <index.json> <name> <repository> <version> <digest> --scan <scan.json> ...` makes the build's entry,
  taking `stable` only if that doesn't regress the channel. The index job collects every image's entry and records them
  with `index.ts record <index.json> build-*.json`, then signs and uploads the result.
- Every 6 hours the rescan job scans what `stable` names with a fresh Trivy database (`index.ts stable`, then
  `index.ts scan <index.json> <name> <digest> <trivy.json>`), re-signs and re-uploads the index, and dispatches a
  rebuild of the images `index.ts needs-rebuild` names.
- `index.ts summary` prints the Markdown table the jobs put in their summaries.

An index file that doesn't exist is an empty index (the first build), and `-` reads it from standard input. Each script
lists its commands in its header. The tests are in `test/`, run by the root `pnpm test`.

## Verifying

The index, signed keyless by the workflow on main:

```sh
curl -fsSLO https://github.com/lleverage-ai/kantel/releases/download/base-images/index.json
curl -fsSLO https://github.com/lleverage-ai/kantel/releases/download/base-images/index.json.sigstore.json
cosign verify-blob --bundle index.json.sigstore.json \
  --certificate-identity-regexp '^https://github.com/lleverage-ai/kantel/\.github/workflows/sandbox-image\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  index.json
```

An image, by its channel or by a digest from the index:

```sh
cosign verify ghcr.io/lleverage-ai/kantel-sandbox:stable \
  --certificate-identity-regexp '^https://github.com/lleverage-ai/kantel/\.github/workflows/sandbox-image\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The scan it was published with is attached as a vuln attestation: `cosign verify-attestation --type vuln` with the same
identity. A host image release's `manifest.json` has its bundle beside it (`manifest.json.sigstore.json`), checked the
same way as the index.
