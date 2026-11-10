# apps/cli: kantel and kantel-admin, in Go

Kantel's command lines as native binaries, with no Node.js: `kantel` (sandboxes, from a terminal, a script or a
coding agent, and its MCP server) and `kantel-admin` (running a self-hosted Kantel). They keep to the conventions in
[packages/cli/CONVENTIONS.md](../../packages/cli/CONVENTIONS.md).

```sh
go build -o kantel ./cmd/kantel      # about 8 ms to start, one static binary
go test ./...
go run ./internal/api/gen            # after the API changes: regenerate the client from openapi.json
go run ./internal/api/gen -check     # CI: fails if the generated client is out of date
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
