#!/usr/bin/env bash
# check-control-plane.sh <version>: tells the hosted control plane that Kantel v<version> is out, so it reads the latest
# kantel-host release now and its console offers hosts the update straight away, rather than within the hour
# (POST /v1/hosts/releases/check, packages/hosts/src/http.ts). The call names no version: the control plane reads
# GitHub's latest release itself. Hourly reading stays as the fallback.
#
#   KANTEL_RELEASE_CHECK_TOKEN  the shared secret, the control plane's Worker secret of the same name. Unset: skipped
#                               with a warning.
#   KANTEL_CONTROL_PLANE_URL    where to call; default https://app.kantel.dev
#   KANTEL_RELEASES_LATEST_URL  GitHub's latest release redirect; default this repository's
#
# It never fails the release: a missing token, a prerelease, a refusal or a control plane that can't be reached is a
# warning, and it exits 0. Nothing here prints the token.
set -uo pipefail

version=${1:?usage: check-control-plane.sh <version>}
version=${version#v}
token=${KANTEL_RELEASE_CHECK_TOKEN:-}
base=${KANTEL_CONTROL_PLANE_URL:-https://app.kantel.dev}
base=${base%/}
latest_url=${KANTEL_RELEASES_LATEST_URL:-https://github.com/${GITHUB_REPOSITORY:-lleverage-ai/kantel}/releases/latest}
# Seconds between tries: past the control plane's 30-second gap between checks, so a retry reads again.
retry_after=${KANTEL_CHECK_RETRY_SECONDS:-35}
# The longest wait for GitHub to name the release, network time included.
wait_seconds=${KANTEL_CHECK_WAIT_SECONDS:-120}

warn() {
	echo "::warning::$*"
	exit 0
}

if [[ -z "$token" ]]; then
	warn "KANTEL_RELEASE_CHECK_TOKEN isn't set, so $base wasn't told about v$version; it reads the release within the hour. tools/release/README.md says how to set it."
fi
if [[ "$version" == *-* ]]; then
	echo "v$version is a prerelease, never the latest release: the control plane has nothing new to read."
	exit 0
fi

# GitHub's latest-release redirect can lag a new release by a few seconds; until it names this one, the control plane
# would read the one before. Wait for it (`wait_seconds` at most, however slow GitHub is), then call either way.
deadline=$((SECONDS + wait_seconds))
location=""
while :; do
	left=$((deadline - SECONDS))
	if ((left > 0)); then
		location=$(curl -sS -o /dev/null --max-time "$((left < 10 ? left : 10))" -w '%{redirect_url}' "$latest_url" 2>/dev/null) ||
			location=""
	fi
	if [[ "$location" == */releases/tag/v$version ]]; then
		echo "$latest_url names v$version."
		break
	fi
	left=$((deadline - SECONDS))
	if ((left <= 0)); then
		echo "$latest_url still names ${location:-nothing} rather than v$version; asking the control plane anyway."
		break
	fi
	sleep "$((left < 5 ? left : 5))"
done

body=$(mktemp)
trap 'rm -f "$body"' EXIT
for attempt in 1 2 3; do
	# The header goes on stdin, so the token is never on a command line.
	status=$(printf 'Authorization: Bearer %s\n' "$token" |
		curl -sS -o "$body" --max-time 30 -w '%{http_code}' -X POST -H @- \
			-H 'content-type: application/json' --data '{}' "$base/v1/hosts/releases/check" 2>/dev/null) || status=000
	case "$status" in
	200)
		answer=$(cat "$body")
		echo "$base answered: $answer"
		if [[ "$(tr -d '[:space:]' <"$body")" == *"\"latestVersion\":\"$version\""* ]]; then
			echo "$base offers hosts kantel-host $version."
			exit 0
		fi
		;;
	401 | 403)
		warn "$base refused the release check ($status): its KANTEL_RELEASE_CHECK_TOKEN Worker secret and this repository's Actions secret differ, or the Worker has none. It reads the release within the hour."
		;;
	*)
		echo "$base answered $status: $(head -c 500 "$body" 2>/dev/null)"
		;;
	esac
	if ((attempt < 3)); then sleep "$retry_after"; fi
done
warn "$base didn't confirm kantel-host $version; it reads the release within the hour, or a super-admin can use Check for updates on its Hosts page."
