# @kantel/isolate-guest

kantel-isolate's guest pieces, for an embedder's own guest bundle ([EMBEDDING.md](../EMBEDDING.md) is the contract
with the runtime):

| Import | What it is |
| --- | --- |
| `@kantel/isolate-guest` | `createGuest(options)`: a guest bundle's `__kantel` (`init(kind)` installs the guards, builds the kind's entry point, and removes every route to the ops), plus `createShell`, `manifestFilesystem`, `prescan`, `createNode`, `createPython` and the guards (`fixBuffers`, `captureShared`, `installWasmGuard`) |
| `@kantel/isolate-guest/shell` | `createShell(ops, { filesystem, commands, log })`: just-bash over any `ShellFilesystem`, with `node`/`python` runs, the embedder's own commands, stubs for what an isolate lacks, and the parse-before-run check (`needsMicrovm`, `effects`) |
| `@kantel/isolate-guest/shell/manifest-fs` | `manifestFilesystem(ops)`: Kantel's filesystem, a lazy in-memory one per command over the runtime's workspace ops |
| `@kantel/isolate-guest/shell/prescan` | `prescan(ast, lookup)`: the parse-before-run check alone, over just-bash's parse |
| `@kantel/isolate-guest/node`, `/python` | `createNode(ops)`, `createPython(ops, lockdown)`: the node and python runtimes |
| `@kantel/isolate-guest/common/*` | the memory guards (`buffer-guard`, `wasm-guard`, `primordials`) and the web polyfills |
| `@kantel/isolate-guest/just-bash-patches` | `patchJustBashBrowser(source)`: the build-time patch to just-bash's browser bundle |
| `@kantel/isolate-guest/patches/just-bash@3.6.0.patch` | the package patch for just-bash 3.6.0 |

A shell filesystem is `{ open(request) }`, where `open` gives, for one command:

- `fs`: a just-bash `IFileSystem` with the sandbox's files under `/workspace`;
- `childIndex(chunks)`: the files as a `node`/`python` run sees them (`shell/manifest-fs.js` has the format);
- `unchanged()`: the reply's `{ manifest, changed }` when the command didn't run (refused before running);
- `finish()`: save the command's changes; `{ manifest, changed, commit? }`, where `commit` (`{ status, error }`) says
  when they weren't saved;
- `adoptStaged(path, staged, mode)` (optional): keep a host command's staged output as a file it doesn't read, and
  commit it by its blob.

The embedder's host commands (EMBEDDING.md, "Host commands") are commands of the same name in the shell.

## The embedder's own commands

`commands` adds commands written in JavaScript to the shell: a host command's front-end (its argument parsing and file
references), or a small command of the embedder's own. Each is `{ name, run(args, ctx, shell), override }`:

- `run` gets the arguments, just-bash's command context and `shell`, and answers just-bash's
  `{ stdout, stderr, exitCode }`. `ctx.fs` is the command's filesystem, so what it writes there is a change of the
  shell command like any other.
- `shell.host(name, args, { stdin, cwd, env })` runs one of the embedder's host commands as the shell would (with the
  files as they are, and its writes applied to the shell's files). It answers `{ exitCode, stdout, stderr }` as bytes.
  The options default to the command's own.
- Nothing a command gets can commit or stage. Its changes are saved by the shell command's one commit, as a host
  command's are, so an unknown outcome or a stopped command is handled once for everything.
- A name the shell already has is an error unless the command says `override: true`. That covers just-bash's
  commands (`rg` is one), `curl`, `wget`, `node`, `python`, `python3` and the embedder's host commands. A clash with
  a built-in throws from `createShell`. The host commands' names are known only when a command runs, so a clash with
  one throws from every `exec`. A name the isolate lacks (`git`, say) needs no override, and the command then runs
  instead of the stub and isn't refused before running.

```js
const rg = {
	name: "rg",
	override: true,
	run: async (args, ctx, shell) => {
		const done = await shell.host("rg", ["--json", ...args]);
		return { stdout: formatMatches(done.stdout), stderr: "", exitCode: done.exitCode };
	},
};
globalThis.__kantel = createGuest({ shell: { filesystem: myFilesystem(ops), commands: [rg] } });
```

## Using it

It isn't on npm. Depend on it at a pinned commit of this repository, with its path, for example with pnpm:

```json
"@kantel/isolate-guest": "github:lleverage-ai/kantel#<commit>&path:/apps/host/isolate-runtime/guest"
```

It is plain ES modules. The bundle the runtime evaluates is one classic script, built for the browser target, with:

- just-bash at 3.6.0 with `patches/just-bash@3.6.0.patch` applied (`patchedDependencies` in pnpm or bun);
- `patchJustBashBrowser` applied to just-bash's `dist/bundle/browser.js` as it is bundled;
- `zlib` / `node:zlib` resolved to `shell/zlib.js` (the runtime's own, through its op);
- strict mode throughout.

`guest/build.ts` is Kantel's build with all of that, and `guest/main.js` Kantel's bundle:
`globalThis.__kantel = createGuest()`. An embedder's is the same with its own filesystem:

```js
import { createGuest } from "@kantel/isolate-guest";
import { myFilesystem } from "./my-filesystem.js";

globalThis.__kantel = createGuest({ shell: { filesystem: myFilesystem(globalThis.Deno.core.ops) } });
```
