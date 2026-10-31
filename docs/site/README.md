# Kantel's public docs

The documentation for people who use Kantel's console, run a deployment or build an app on its API. The rest of
`docs/` is for the people building Kantel (design notes, measurements, contracts) and stays as it is.

## Why Starlight

The site is laid out for [Starlight](https://starlight.astro.build), Astro's documentation theme, rather than Fumadocs:

- **Pages are plain Markdown.** Starlight renders `.md` with a small frontmatter (`title`, `description`,
  `sidebar.order`), so the pages read well on GitHub too and anyone can edit them without knowing React. Fumadocs is
  built on Next.js and leans on MDX and React components.
- **It is static.** Astro builds plain HTML, which any static host serves, Cloudflare Pages or Workers static assets
  included, with no server to run.
- **Search, navigation, dark mode and edit links come with it**, so the site needs only the config in
  `astro.config.mjs` and the content.

Nothing installs or builds the site yet, so it adds no dependencies to the repository. To build it, add a
`package.json` here with `astro` and `@astrojs/starlight`, then run `astro build`.

## Layout

| Path | What |
| --- | --- |
| `astro.config.mjs` | Starlight's config and the sidebar |
| `src/content.config.ts` | The docs collection, with Starlight's frontmatter schema |
| `src/content/docs/index.md` | The home page |
| `src/content/docs/console/` | Using the console, from installing to sharing |
| `src/content/docs/deploy/` | Cloudflare and self-hosted deployments |
| `src/content/docs/api/` | Building apps: concepts, authentication, quick start, streaming, approvals and more |
| `src/content/docs/api/reference/` | The API reference. Generated, except `index.md` and `unlisted.md` |
| `src/content/docs/gaps.md` | What Kantel doesn't do yet |
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
- Describe what the code does today. Mark anything planned, in review or not yet merged as such, and put what's
  missing on the gaps page rather than describing it as if it worked.
- Each page ends with an HTML comment listing the source files and lines it was checked against, and the commit.
  Update it when you check the page again.
- Give examples in TypeScript, with the generated SDK, and in `curl`.

The pages were written against commit `8584d5b` and brought up to date with `d031001`, which added connections.
