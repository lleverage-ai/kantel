#!/usr/bin/env bash
# Build the node-local seed cache that the self-hosted (and Cloudflare image) runs read:
#   $CACHE/mirrors/<n>.git          warm bare mirror
#   $CACHE/lower/<n>                prepared checkout + node_modules (overlay lower layer)
#   $CACHE/deps/<n>-<key>.tar.zst   node_modules archive keyed by lockfile hash
#   $CACHE/sqsh/<n>.sqsh            SquashFS image of the prepared checkout
# Everything heavy runs inside the bench image, as the calling user.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../fixtures.env
source "$here/../fixtures.env"
CACHE="${CACHE:?set CACHE to the cache root}"
IMAGE="${IMAGE:-harbour-m0-seed-bench:local}"
only="${1:-}"
mkdir -p "$CACHE"/{mirrors,lower,deps,sqsh,home}

in_box() { docker run --rm --user "$(id -u):$(id -g)" -e HOME=/cache/home -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e CI=1 -v "$CACHE:/cache" -w /cache "$IMAGE" bash -euo pipefail -c "$1"; }

for f in "${FIXTURES[@]}"; do
  IFS='|' read -r name gh sha sparse install <<<"$f"
  [[ -n "$only" && "$only" != "$name" ]] && continue
  echo "== $name"
  [[ -d "$CACHE/mirrors/$name.git" ]] || git clone -q --bare "https://github.com/$gh.git" "$CACHE/mirrors/$name.git"
  git -C "$CACHE/mirrors/$name.git" cat-file -e "$sha^{commit}"
  if [[ ! -d "$CACHE/lower/$name/.git" ]]; then
    in_box "git clone -q --shared --no-checkout /cache/mirrors/$name.git /cache/lower/$name && git -C /cache/lower/$name checkout -q --detach $sha"
  fi
  lock=$(cd "$CACHE/lower/$name" && ls bun.lock pnpm-lock.yaml 2>/dev/null | head -1 || true)
  key=$( (cat "$CACHE/lower/$name/$lock"; echo "node24-bench-image") | sha256sum | cut -c1-16)
  if [[ ! -f "$CACHE/deps/$name-$key.tar.zst" ]]; then
    start=$(date +%s)
    in_box "cd /cache/lower/$name && export npm_config_store_dir=/cache/pnpm-store && $install >/cache/home/install-$name.log 2>&1 || (tail -40 /cache/home/install-$name.log; exit 1)"
    echo "install_s=$(( $(date +%s) - start ))"
    in_box "cd /cache/lower/$name && find . -name node_modules -type d -prune -print > /cache/home/nm-$name.list && tar -c -T /cache/home/nm-$name.list | zstd -q -T0 -3 -o /cache/deps/$name-$key.tar.zst"
  fi
  # Settle the index: a status run more than a second after checkout rewrites it, so no entry is
  # "racily clean". Otherwise every restored copy rehashes every file on its first git status.
  in_box "sleep 1.1 && git -C /cache/lower/$name status --porcelain >/dev/null"
  [[ -f "$CACHE/sqsh/$name.sqsh" ]] || in_box "mksquashfs /cache/lower/$name /cache/sqsh/$name.sqsh -comp zstd -quiet -no-progress >/dev/null"
  echo "key=$key lock=$lock"
  du -sh "$CACHE/mirrors/$name.git" "$CACHE/lower/$name" "$CACHE/deps/$name-$key.tar.zst" "$CACHE/sqsh/$name.sqsh"
done
