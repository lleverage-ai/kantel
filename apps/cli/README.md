# apps/cli: kantel and kantel-admin, in Go

Kantel's command lines as native binaries, with no Node.js: `kantel` (sandboxes, from a terminal, a script or a
coding agent, and its MCP server) and `kantel-admin` (running a self-hosted Kantel). They keep to the conventions in
[packages/cli/CONVENTIONS.md](../../packages/cli/CONVENTIONS.md).

```sh
go build -o kantel ./cmd/kantel      # about 8 ms to start, one static binary
go test ./...
go run ./internal/api/gen            # after the API changes: regenerate the client from openapi.json
go run ./internal/api/gen -check     # CI: fails if the generated client is out of date
go run ./cmd/kantel-docs             # after a command changes: regenerate the docs' command reference
go run ./cmd/kantel-docs -check      # CI: fails if it is out of date (so does go test)
```

- `internal/api` is the API client. `types_gen.go` and `client_gen.go` are generated from
  `packages/api/generated/openapi.json` (itself generated from `packages/api/src/routes.ts`); `runtime.go` is what they
  call: retries where a call is safe to send again, `Idempotency-Key`s, `api.Raw` to keep Kantel's answer as it is for
  `--json`, and `api.Nullable` for a field that may be `null`.
- `internal/cli` is what both programs are built on: the command table (`Program`, `Section`, `Command`, `Flag`), from
  which help, `help --json`, completion and the docs' reference are made; the parser; errors and exit codes; colour,
  tables and spinners for a terminal only; config.
- `internal/kantel` is `kantel`'s commands, one file per section of its help (`sandboxes.go` is "Sandboxes"). A command
  reads its flags from `*cli.Context`, gets its client with `Client(c)`, and prints with `c.Emit(raw, value, human)`:
  Kantel's raw answer with `--json`, else the human text.
- `internal/kantel/harness_test.go` runs the CLI against a fake Kantel (`run(t, argv, opts{routes: …})`); every
  command's examples are checked to parse.
- `internal/cli`'s `Program.Before` and `Program.After` run around every command that runs (not help, `--version`,
  `__complete` or a usage mistake): `kantel` uses them for its update notice.
- `cmd/kantel-docs` writes `docs/site/src/content/docs/tools/cli-reference.md` from `Program().SchemaOf()`
  (`internal/kantel/reference.go`), in the TypeScript generator's format; `TestReferenceIsCurrent` fails when the
  committed page is stale, so a command that changes regenerates it.

## Releases, install and update

`tools/release/pack.sh` builds `kantel-<os>-<arch>` and `kantel-admin-<os>-<arch>` for linux and darwin on amd64 and
arm64 (`CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X …/internal/kantel.Version=<v> -X …/internal/admin.Version=<v>"`)
into the GitHub Release with `SHA256SUMS`; [tools/release/README.md](../../tools/release/README.md) has the rest.

- `install-cli.sh` (served as `https://kantel.dev/cli.sh` by apps/site, and stamped into each release) installs the
  binary for the machine into `~/.local/bin`, checked against `SHA256SUMS`.
- `kantel update` (`internal/kantel/update.go`, with `release.go`) finds the latest release from where GitHub's
  `releases/latest` redirects, downloads this platform's binary, checks its SHA-256 and that it runs and prints the
  version, and renames it over `IO.Self` (its links resolved), and over `kantel-admin` beside it. A directory it can't
  write to fails with the fix: `sudo <path> update`, or reinstall for yourself with `cli.sh`.
- The update notice (`internal/kantel/notice.go`): `Program.Before` reads
  `${XDG_CACHE_HOME:-~/.cache}/kantel/update-check.json` and, when it is a day old, asks for the latest release in
  the background (1.5 s at most); `Program.After` prints `A new kantel is out: …` on stderr if a newer release is
  known by then, never waiting for the check. Off for a development build (`Version` 0.0.0), `--json`, stderr not a
  terminal, `CI`, `KANTEL_NO_UPDATE_NOTIFIER` or `NO_UPDATE_NOTIFIER`, a coding agent (`CLAUDECODE`, `CODEX_*`,
  `CURSOR_AGENT`, `AI_AGENT`, `GEMINI_CLI`, `OPENCODE`), and `update`, `mcp` and `completion`.
- `KANTEL_RELEASE_URL` points all three at a mirror directory (`https://` or `file://`) holding one release's files.
