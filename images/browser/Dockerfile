# Kantel's browser image, copied from tvdavies/brwsr@0d22bf8 container/Dockerfile
# (packages/browser/CONTRACT.md). One Chromium and its agent per browser, run
# by the Cloudflare KantelBrowser Durable Object or the self-hosted browser
# host. Left out of brwsr's image: CAPTCHA solving, ad blocking, proxies and
# tunnels, and server-side credential fills. Two engines:
#   headless-shell  Chrome for Testing's chrome-headless-shell: faster to launch
#                   and lighter, but no extensions and easier to fingerprint.
#                   The default (DEFAULT_ENGINE).
#   chromium        Debian Chromium in new headless mode: full browser, extensions,
#                   closest to a real Chrome. Picked by /start's `engine`.
# Plus a small Node agent that proxies CDP, streams the live view, and saves
# and restores the profile. Session recording only captures frames here;
# nothing is encoded in this container.
#
# agent/ stays as close to brwsr's as Kantel's changes allow, so a later sync
# from brwsr diffs cleanly: biome.json leaves it out of `pnpm lint`, and each
# file's header says what Kantel changed.

# Base images are pinned by digest (the one brwsr's production ran on 23 Oct
# 2026), so the same Dockerfile always starts from the same image. To update,
# replace the digest (docker buildx imagetools inspect node:22-bookworm-slim).
# apt-get below still installs Debian's current packages whenever the image is
# rebuilt.

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# Same version as Debian's chromium, so a context saved by one engine opens in
# the other (Chrome won't open a profile from a newer version).
ARG HEADLESS_SHELL_VERSION=155.0.8059.79
ARG HEADLESS_SHELL_SHA256=4cea4c32b501aa43cc2b81eb45734af991a6a82feded48380d6dfaf96642a1c1

# Fonts: Liberation for the metric-compatible Latin faces, Noto core for the
# other scripts (Arabic, Hebrew, Devanagari, Thai, Greek, ...; ~43 MB), Noto
# CJK and Noto Color Emoji. Without a font for a script, screenshots show
# empty boxes (tofu) for it.
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      fonts-noto-core \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      ca-certificates curl tar gzip zip unzip dumb-init \
 && curl -fsSLo /tmp/hs.zip "https://storage.googleapis.com/chrome-for-testing-public/${HEADLESS_SHELL_VERSION}/linux64/chrome-headless-shell-linux64.zip" \
 && echo "${HEADLESS_SHELL_SHA256}  /tmp/hs.zip" | sha256sum -c - \
 && unzip -q /tmp/hs.zip -d /opt && rm /tmp/hs.zip \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man

# Warm the font cache and build a first-run profile template at image build
# time, so a fresh session skips that work (~0.5 s at 1/4 vCPU).
RUN chromium --version | tee /opt/chromium.version \
 && /opt/chrome-headless-shell-linux64/chrome-headless-shell --version | tee /opt/headless-shell.version \
 && fc-cache -f >/dev/null \
 && (timeout 60 chromium --headless=new --no-sandbox --disable-gpu --no-first-run \
      --user-data-dir=/opt/profile-template --password-store=basic --dump-dom about:blank \
      >/dev/null 2>&1 || true) \
 && rm -f /opt/profile-template/Singleton* /opt/profile-template/DevToolsActivePort \
 && rm -rf /opt/profile-template/*/Cache /opt/profile-template/*/"Code Cache" /opt/profile-template/*/GPUCache

WORKDIR /agent
# Modes set here, not taken from the checkout (a umask 077 worktree has 0600 files).
COPY --chmod=644 agent/package.json agent/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --chmod=u=rwX,go=rX agent/ ./

RUN mkdir -p /data
ENV CHROME_PATH=/usr/bin/chromium \
    HEADLESS_SHELL_PATH=/opt/chrome-headless-shell-linux64/chrome-headless-shell \
    PROFILE_TEMPLATE=/opt/profile-template
EXPOSE 8080

# The build this image is, reported in the agent's /health (its `build`
# field). A plain build says "dev". Last, so a new value rebuilds nothing
# above.
ARG BROWSER_IMAGE_BUILD=dev
ENV BROWSER_IMAGE_BUILD=${BROWSER_IMAGE_BUILD}
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "/agent/server.mjs"]
