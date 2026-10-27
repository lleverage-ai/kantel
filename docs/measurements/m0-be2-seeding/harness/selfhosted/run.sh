#!/usr/bin/env bash
# Self-hosted seeding runs: one fresh container per iteration, as a sandbox would get.
#   CACHE=... OUT=raw.jsonl N=50 run.sh [repo-filter] [method-filter]
# Each output line is seed-op's JSON plus target, iteration and total_ms
# (host wall time from `docker run` to exit, i.e. container start + seeding op).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../fixtures.env
source "$here/../fixtures.env"
CACHE="${CACHE:?}"; OUT="${OUT:?}"; N="${N:-50}"; IMAGE="${IMAGE:-harbour-m0-seed-bench:local}"
RUNTIME="${RUNTIME:-runc}"; TARGET="${TARGET:-selfhosted-docker-$RUNTIME}"
repo_f="${1:-}"; method_f="${2:-}"
METHODS="${METHODS:-container-start worktree ref-full ref-sparse overlay fuse-overlay squashfs deps-archive snapshot-image}"

ms() { echo $(( $(date +%s%N) / 1000000 )); }
failures=0

one() { # name method iteration docker-args... -- seed-op args...
  local name=$1 method=$2 i=$3; shift 3
  local dargs=() sargs=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do dargs+=("$1"); shift; done; shift
  sargs=("$@" "stat=${STAT:-default}")
  local t0 t1 line
  t0=$(ms)
  if ! line=$(docker run --rm --runtime "$RUNTIME" "${dargs[@]}" "${sargs[@]}" 2>/tmp/seed-err.$$); then
    t1=$(ms); failures=$((failures + 1))
    echo "FAIL $name $method $i: $(tail -3 /tmp/seed-err.$$)" >&2
    # Keep the failed attempt in the raw data (summarise.mjs skips ok:false lines).
    jq -nc --arg t "$TARGET" --argjson i "$i" --argjson total $((t1 - t0)) --arg m "$method" --arg r "$name" \
      --arg s "${STAT:-default}" --arg e "$(tail -3 /tmp/seed-err.$$)" \
      '{ok:false, target:$t, iteration:$i, total_ms:$total, method:$m, repo:$r, stat:$s, error:$e}' >>"$OUT"
    return 0
  fi
  t1=$(ms)
  line=$(tail -1 <<<"$line")
  jq -c --arg t "$TARGET" --argjson i "$i" --argjson total $((t1 - t0)) --arg m "$method" --arg r "$name" --arg s "${STAT:-default}" \
    '. + {target:$t, iteration:$i, total_ms:$total, method:$m, repo:$r, stat:$s}' <<<"$line" >>"$OUT"
}

for f in "${FIXTURES[@]}"; do
  IFS='|' read -r name gh sha sparse install <<<"$f"
  [[ -n "$repo_f" && "$repo_f" != "$name" ]] && continue
  deps=$(ls "$CACHE"/deps/"$name"-*.tar.zst | head -1)
  for method in $METHODS; do
    [[ -n "$method_f" && "$method_f" != "$method" ]] && continue
    n=$N; [[ "$method" == github-sparse ]] && n="${NNET:-10}"
    if [[ "$method" == snapshot-image ]]; then
      # Self-hosted analogue of a container snapshot: the prepared checkout baked into an image layer.
      # Copy then commit, not `docker build`: a build context honours the repo's own .dockerignore
      # (n8n's excludes almost everything).
      if ! docker image inspect "harbour-m0-seed-snap-$name:local" >/dev/null 2>&1; then
        cid=$(docker create --network none -v "$CACHE/lower/$name:/src:ro" "$IMAGE" sh -c 'mkdir -p /workspace/w && cp -a /src/. /workspace/w/')
        docker start -a "$cid" >/dev/null
        docker commit -c 'CMD ["sleep","infinity"]' "$cid" "harbour-m0-seed-snap-$name:local" >/dev/null
        docker rm "$cid" >/dev/null
      fi
    fi
    echo "$(date +%T) $name $method x$n" >&2
    for i in $(seq 1 "$n"); do
      case "$method" in
        container-start) one "$name" "$method" "$i" --network none "$IMAGE" -- seed-op noop repo="$name" ;;
        worktree)
          one "$name" "$method" "$i" --network none -v "$CACHE/mirrors:/cache/mirrors" "$IMAGE" -- \
            seed-op worktree repo="$name" sha="$sha" mirror="/cache/mirrors/$name.git" dst="/workspace/w"
          docker run --rm --network none -v "$CACHE/mirrors:/cache/mirrors" "$IMAGE" git -C "/cache/mirrors/$name.git" worktree prune ;;
        ref-full|ref-sparse)
          one "$name" "$method" "$i" --network none -v "$CACHE/mirrors:/cache/mirrors:ro" "$IMAGE" -- \
            seed-op "$method" repo="$name" sha="$sha" mirror="/cache/mirrors/$name.git" dst="/workspace/w" sparse="$sparse" ;;
        github-sparse)
          # Public repos only: no credentials go into the sandbox.
          [[ "$gh" == tvdavies/sal ]] && break
          one "$name" "$method" "$i" "$IMAGE" -- \
            seed-op github-sparse repo="$name" sha="$sha" url="https://github.com/$gh.git" dst="/workspace/w" sparse="$sparse" ;;
        overlay|fuse-overlay)
          one "$name" "$method" "$i" --network none --cap-add SYS_ADMIN --device /dev/fuse \
            -v "$CACHE/mirrors:/cache/mirrors:ro" -v "$CACHE/lower:/cache/lower:ro" "$IMAGE" -- \
            seed-op "$method" repo="$name" lower="/cache/lower/$name" dst="/workspace/w" ;;
        squashfs)
          one "$name" "$method" "$i" --network none --cap-add SYS_ADMIN --device /dev/fuse \
            -v "$CACHE/mirrors:/cache/mirrors:ro" -v "$CACHE/sqsh:/cache/sqsh:ro" "$IMAGE" -- \
            seed-op squashfs repo="$name" sqsh="/cache/sqsh/$name.sqsh" dst="/workspace/w" ;;
        deps-archive)
          one "$name" "$method" "$i" --network none -v "$CACHE/deps:/cache/deps:ro" "$IMAGE" -- \
            seed-op deps-archive repo="$name" archive="/cache/deps/$(basename "$deps")" dst="/workspace/w" ;;
        snapshot-image)
          one "$name" "$method" "$i" --network none -v "$CACHE/mirrors:/cache/mirrors:ro" "harbour-m0-seed-snap-$name:local" -- \
            seed-op status repo="$name" dst="/workspace/w" ;;
      esac
    done
  done
done
if (( failures > 0 )); then echo "done with $failures failed runs (recorded as ok:false in $OUT)" >&2; exit 1; fi
