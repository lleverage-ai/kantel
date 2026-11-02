# Kantel's public docs

The documentation for people who use Kantel's console, run a deployment or build an app on its API. It is a
[Starlight](https://starlight.astro.build) site: plain Markdown pages with a small frontmatter (`title`,
`description`, `sidebar.order`), built to static HTML.

## Building it

The site isn't part of the pnpm workspace, so it adds no dependencies to the repository. To build it, add a
`package.json` here with `astro` and `@astrojs/starlight`, install, then run `astro build`. The pages are written in
`dist/`.

kantel.dev (`apps/site`) serves these same pages under `/docs/`: it copies `src/content/docs` and takes `sidebar.mjs`
as it builds, so an edit here reaches it with nothing else to change. Its build fails on a broken internal link.

## Layout

| Path | What |
| --- | --- |
| `astro.config.mjs` | Starlight's config |
| `sidebar.mjs` | The sidebar, shared with kantel.dev |
| `src/content.config.ts` | The docs collection, with Starlight's frontmatter schema |
| `src/content/docs/index.md` | The home page |
| `src/content/docs/console/` | Using the console, from installing to sharing |
| `src/content/docs/deploy/` | Cloudflare and self-hosted deployments |
| `src/content/docs/api/` | Building apps: concepts, authentication, quick start, streaming, approvals and more |
| `src/content/docs/api/reference/` | The API reference. Generated, except `index.md` and `unlisted.md` |
| `scripts/api-reference.ts` | Writes the API reference from the OpenAPI document |

## The API reference

The reference pages are generated from `packages/api/generated/openapi.json`, which is itself generated from the
routes in `packages/api/src/routes.ts`. After changing a route:

```sh
pnpm --filter @kantel/api generate
pnpm docs:reference
```

and commit both. CI runs `node docs/site/scripts/api-reference.ts --check`, which fails while a page is stale.

Routes the deployments serve outside the public API are listed by hand in `api/reference/unlisted.md`. Move a route
out of it when it joins the public API.

## Writing

- Plain British English, sentence-case headings, and the second person. Say what something does, not how good it is.
- The product is Kantel, by Lleverage. It was called Harbour before the rename, and a few names keep that: `hbr_` keys, `harbour-*` headers, the `harbour` Worker. Write them as they are. Packages are `@kantel/*` and settings `KANTEL_*`.
- Kantel adds no system prompt of its own. Don't write as if it did.
- Describe what the code does today. Don't describe unmerged or planned work; where a feature has limits, say so on
  its page.
- Each page ends with an HTML comment listing the source files and lines it was checked against, and the commit.
  Update it when you check the page again.
- Give examples in TypeScript, with the generated SDK, and in `curl`.
