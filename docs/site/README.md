# Kantel's public docs

The documentation for people who use Kantel: what it is, how to run it, and how to drive its sandboxes from the
console, the API, the SDK, the CLI, the MCP server and coding agents. It is a [Starlight](https://starlight.astro.build)
site: plain Markdown pages with a small frontmatter (`title`, `description`, `sidebar`), built to static HTML.

Usage docs only. Design notes, plans and proposals don't belong here, or anywhere in the repository.

## Building it

kantel.dev (`apps/site`) serves these pages under `/docs/`: it copies `src/content/docs` and takes `sidebar.mjs` as it
builds, so an edit here reaches it with nothing else to change. Build and preview it from the repository root:

```sh
pnpm --dir apps/site install --ignore-workspace
pnpm --dir apps/site dev      # http://localhost:4321/docs/
pnpm --dir apps/site build    # dist/, then checks every internal link and writes llms.txt
```

Its build fails on a broken internal link, and on a sidebar entry with no page.

This directory isn't part of the pnpm workspace and has no `package.json` of its own. To build it on its own, add one
with `astro` and `@astrojs/starlight`, install, then run `astro build`.

## Layout

| Path | What |
| --- | --- |
| `astro.config.mjs` | Starlight's config, for a build of this directory on its own |
| `sidebar.mjs` | The sidebar, shared with kantel.dev. A page that isn't in it isn't in `llms.txt` either |
| `src/content.config.ts` | The docs collection, with Starlight's frontmatter schema |
| `src/content/docs/index.md` | The home page, what Kantel is |
| `src/content/docs/self-hosting/` | Installing and running the control plane and hosts |
| `src/content/docs/api/reference/` | The API reference. Generated, except `index.md` |
| `scripts/api-reference.ts` | Writes the API reference from the OpenAPI document |

## For agents: llms.txt

`apps/site/scripts/llms-txt.mjs` runs after the build and writes, under `/docs/`:

- `llms.txt`: every page in sidebar order, under the sidebar's group labels, with its description;
- `<page>.md`: each page as plain Markdown, such as `/docs/concepts.md`, with links pointing at the other pages' `.md`;
- `llms-full.txt`: every page in one file.

A page's `description` is its line in `llms.txt`, so write it as a sentence that says what the page answers.

## The API reference

The reference pages are generated from `packages/api/generated/openapi.json`, which is itself generated from the
routes in `packages/api`. After changing a route:

```sh
pnpm --filter @kantel/api generate
pnpm docs:reference
```

and commit both. CI runs `node docs/site/scripts/api-reference.ts --check`, which fails while a page is stale.

Each tag gets a page. Give a new tag its title, order and a line about it in `TAGS` in `scripts/api-reference.ts`. The
agent plane's tags are in `NOT_DOCUMENTED` there: their routes get no page while their code is removed. Take a tag out
of that list once its routes have gone.

## Experimental pages

Mark a page whose feature is behind a switch, or still landing, with a badge in its frontmatter and a note at its top:

```md
---
title: Fork a sandbox
description: …
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
Say what's missing or what turns it on, in a sentence.
:::
```

`llms.txt` marks the same pages `(experimental)`. Take both away when the feature is on by default and complete.

## Writing

- Plain British English, sentence-case headings, and the second person. Say what something does, not how good it is.
- Write every page fresh. Other products' docs can suggest what a page should cover, never its wording.
- The product is Kantel, by Lleverage. It was called Harbour before the rename, and a few names keep that: `hbr_` keys,
  `HARBOUR_*` settings, `harbour` in image, database and Worker names. Write them as they are. Packages are
  `@kantel/*` and settings `KANTEL_*`.
- Describe what the code does. Where a feature has limits, say so on its page. Every command and example must run
  against the code as it is: check it against the source or run it.
- Give examples with `curl`, the TypeScript SDK and the `kantel` CLI, as each exists. Shell examples work in bash and
  zsh; where fish differs (`set -x` for `export`), say so.
- Each page ends with an HTML comment listing the source files and lines it was checked against, and the commit.
  Update it when you check the page again. `llms.txt` and the `.md` pages leave these comments out.
