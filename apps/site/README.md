# kantel.dev

Kantel's public site: the marketing page, the install script and the docs, built by Astro into one static site and
served from Cloudflare Workers static assets.

| Path | What |
| --- | --- |
| `/` | The marketing page, `src/pages/index.astro` |
| `/install.sh` | The installer, `public/install.sh`, served as is |
| `/docs/` | The usage docs in `docs/site`, copied in at build time (see below) |

## Building it

The site isn't part of the pnpm workspace: it has its own lockfile, so Astro's and Wrangler's dependencies don't
change the workspace's.

```sh
pnpm --dir apps/site install --ignore-workspace
pnpm --dir apps/site dev      # http://localhost:4321
pnpm --dir apps/site build    # dist/, then checks every internal link
pnpm --dir apps/site preview  # wrangler dev, serving dist/ as Cloudflare would
```

CI runs the build on every pull request, with `sh -n` on the installer.

## The docs

`scripts/sync-docs.mjs` copies `docs/site/src/content/docs` into `src/content/docs/docs/` before every dev and build,
so the pages are served under `/docs/` and edits to `docs/site` flow through with nothing to copy by hand. The copy is
git-ignored. Both sites take their sidebar from `docs/site/sidebar.mjs`, with `/docs/` in front of every link here.
Only usage docs are copied: design and planning docs elsewhere in `docs/` aren't.

`scripts/check-links.mjs` runs after the build and fails it when an internal link, on the marketing page or in the
docs, doesn't resolve to a built page or asset.

## The installer

`public/install.sh` is POSIX sh, so `curl -fsSL https://kantel.dev/install.sh | sh` works from bash, zsh and fish. It
checks for Docker with Compose, downloads the source from GitHub (its `DEFAULT_REPO`, which matches `GITHUB_URL` in
`src/site.mjs`; `main` unless `--ref`),
and then either hands over to the installer at the source's root, when there is one, or starts the self-hosted Compose
stack in `deploy/compose` itself. The comment at its top and `--help` say the rest.

Until the public repository exists, point it at another with `--repo` (a private one downloads through `gh`):

```sh
curl -fsSL https://kantel.dev/install.sh | sh -s -- --repo tvdavies/harbour
```

## Product shots

The screenshots in `src/assets/shots` are of the real console, recorded fixtures and UI stories, not mock-ups.
`src/assets/shots/README.md` says where each comes from and how to take it again.

## Deploying

`wrangler.jsonc` serves `dist/` as static assets on the `kantel.dev` custom domain, with `_headers` for caching and the
installer's content type. Nothing deploys it yet: `pnpm --dir apps/site deploy:dry-run` checks the config, and
`wrangler deploy` from `apps/site`, with an account that holds the `kantel.dev` zone, publishes it.
