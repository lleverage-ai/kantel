#!/usr/bin/env bash
# smoke.sh <version> [out]: checks what pack.sh wrote to out (default dist/release) before anything is published:
#   - SHA256SUMS matches the release's files, and lists each of them;
#   - kantel-host (this machine's architecture), kantel.js, kantel-admin.js and the npm package's kantel all print
#     <version>;
#   - install.sh, pointed at out/github, downloads this machine's kantel-host, checks it against SHA256SUMS and installs
#     it (--no-join), refuses a binary whose SHA-256 doesn't match, hands its options on to `kantel-host install`
#     (with a stand-in binary), and refuses to join without root;
#   - install-cli.sh, pointed at out/github with a HOME of its own, installs kantel and kantel-admin that print
#     <version>, again over the first, and into --dir; it refuses a file whose SHA-256 doesn't match and a Node.js
#     older than 22;
#   - the console's files are in the npm package and kantel-console.tar.gz (packed the same way each time), and
#     install-cli.sh's `kantel console` serves them through its link, and refuses a request without it.
# Runs on Linux x86_64 or arm64, such as the release workflow's runner, as a user other than root.
set -euo pipefail

version=${1:?usage: smoke.sh <version> [out]}
root=$(cd "$(dirname "$0")/../.." && pwd)
out=${2:-$root/dist/release}
github="$out/github"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() {
	echo "smoke: $*" >&2
	exit 1
}
# expect WHAT COMMAND...: COMMAND must print exactly $version.
expect() {
	local what=$1 got
	shift
	got=$("$@") || fail "$what failed"
	[[ "$got" == "$version" ]] || fail "$what printed '$got', not '$version'"
	echo "ok      $what $got"
}

(cd "$github" && sha256sum --check --strict SHA256SUMS) || fail "SHA256SUMS doesn't match the files"
for file in kantel-host-linux-amd64 kantel-host-linux-arm64 kantel.js kantel-admin.js kantel-console.tar.gz install.sh \
	install-cli.sh; do
	grep -q "  $file\$" "$github/SHA256SUMS" || fail "SHA256SUMS has no line for $file"
done

# The console's files: in the tarball, with no runner's owner or times in it.
tar -tzvf "$github/kantel-console.tar.gz" >"$work/console-list"
grep -q " console/index.html\$" "$work/console-list" || fail "kantel-console.tar.gz has no console/index.html"
awk '$2 != "0/0" { bad = 1 } END { exit bad }' "$work/console-list" || fail "kantel-console.tar.gz has files with an owner"
echo "ok      kantel-console.tar.gz has the console, owned by no one"

case "$(uname -m)" in
	x86_64) arch=amd64 ;;
	aarch64) arch=arm64 ;;
	*) fail "runs on x86_64 or arm64, not $(uname -m)" ;;
esac
expect "kantel-host-linux-$arch" "$github/kantel-host-linux-$arch" version
expect "kantel.js" node "$github/kantel.js" --version
expect "kantel-admin.js" node "$github/kantel-admin.js" version
tar -xzf "$out"/npm/kantel-*.tgz -C "$work"
expect "kantel (npm)" node "$work/package/kantel.js" --version
[[ -f "$work/package/console/index.html" ]] || fail "the npm package has no console/index.html"
echo "ok      the npm package has the console"

# console_serves KANTEL: KANTEL's `kantel console` serves the console's page through the link it prints, and nothing
# without it. It needs no gateway until the page asks one for something.
console_serves() {
	local log="$work/console.log" url pid
	KANTEL_URL=https://kantel.invalid KANTEL_API_KEY=kt_smoke KANTEL_NO_BROWSER=1 \
		XDG_CONFIG_HOME="$work/console-config" "$@" console >"$log" 2>&1 &
	pid=$!
	for _ in $(seq 1 50); do
		url=$(grep -oE 'http://127\.0\.0\.1:[0-9]+/[^ ]*' "$log" | head -1 || true)
		[[ -n "$url" ]] && break
		sleep 0.1
	done
	if [[ -z "$url" ]]; then
		kill "$pid" 2>/dev/null || true
		fail "kantel console printed no link: $(cat "$log")"
	fi
	local origin
	origin=$(grep -oE '^http://127\.0\.0\.1:[0-9]+' <<<"$url")
	local without with
	without=$(curl -s -o /dev/null -w '%{http_code}' "$origin/")
	with=$(curl -s -c "$work/console-jar" -b "$work/console-jar" -L -o "$work/console-page" -w '%{http_code}' "$url")
	kill "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
	[[ "$without" == 403 ]] || fail "kantel console answered $without, not 403, without its link"
	[[ "$with" == 200 ]] || fail "kantel console answered $with through its link"
	grep -q '<div id="root"' "$work/console-page" || fail "kantel console's page isn't the console's"
}

# install.sh: the happy path, with curl reading the files from disk.
export KANTEL_RELEASE_URL="file://$github"
KANTEL_BIN_DIR="$work/bin" sh "$github/install.sh" --no-join || fail "install.sh --no-join failed"
expect "install.sh --no-join, then kantel-host" "$work/bin/kantel-host" version

# A binary that doesn't match SHA256SUMS must not be installed.
mkdir "$work/bad"
cp "$github"/* "$work/bad/"
printf 'x' >>"$work/bad/kantel-host-linux-$arch"
if KANTEL_RELEASE_URL="file://$work/bad" KANTEL_BIN_DIR="$work/bad-bin" sh "$github/install.sh" --no-join 2>"$work/err"; then
	fail "install.sh installed a binary whose SHA-256 doesn't match"
fi
grep -q "SHA256SUMS says" "$work/err" || fail "install.sh failed, but not on the checksum: $(cat "$work/err")"
[[ ! -e "$work/bad-bin/kantel-host" ]] || fail "install.sh left a binary that doesn't match"
echo "ok      install.sh refuses a binary that doesn't match SHA256SUMS"

# Joining hands every option on to `kantel-host install`. Run with a stand-in kantel-host that records its arguments,
# and an `id` that says root, so nothing is installed for real.
mkdir "$work/fake" "$work/shim"
cat >"$work/fake/kantel-host-linux-$arch" <<EOF
#!/bin/sh
[ "\$1" = version ] && { echo fake; exit 0; }
printf '%s\n' "\$@" >"$work/args"
EOF
(cd "$work/fake" && sha256sum "kantel-host-linux-$arch" >SHA256SUMS)
printf '#!/bin/sh\necho 0\n' >"$work/shim/id"
chmod 755 "$work/shim/id"
PATH="$work/shim:$PATH" KANTEL_RELEASE_URL="file://$work/fake" KANTEL_BIN_DIR="$work/join-bin" \
	sh "$github/install.sh" --url https://kantel.invalid --token kth_smoke --label zone=x >/dev/null 2>&1 ||
	fail "install.sh failed to join with a stand-in kantel-host"
[[ "$(tr '\n' ' ' <"$work/args")" == "install --url https://kantel.invalid --token kth_smoke --label zone=x " ]] ||
	fail "install.sh ran kantel-host with: $(tr '\n' ' ' <"$work/args")"
echo "ok      install.sh runs kantel-host install with its options"

# --dry-run runs the downloaded binary's install --dry-run from the temporary directory, and installs nothing.
rm -f "$work/args"
PATH="$work/shim:$PATH" KANTEL_RELEASE_URL="file://$work/fake" KANTEL_BIN_DIR="$work/dry-bin" \
	sh "$github/install.sh" --url https://kantel.invalid --dry-run --token kth_smoke >"$work/out" 2>&1 ||
	fail "install.sh --dry-run failed with a stand-in kantel-host: $(cat "$work/out")"
[[ "$(tr '\n' ' ' <"$work/args")" == "install --url https://kantel.invalid --dry-run --token kth_smoke " ]] ||
	fail "install.sh --dry-run ran kantel-host with: $(tr '\n' ' ' <"$work/args")"
[[ ! -e "$work/dry-bin/kantel-host" ]] || fail "install.sh --dry-run installed kantel-host"
echo "ok      install.sh --dry-run runs kantel-host install --dry-run and installs nothing"

# --check runs this release's own doctor, which exits non-zero here: the smoke test isn't root.
if [[ "$(id -u)" != 0 ]]; then
	if PATH="$work/shim:$PATH" KANTEL_BIN_DIR="$work/check-bin" sh "$github/install.sh" --check >"$work/out" 2>&1; then
		fail "install.sh --check passed as a user other than root"
	fi
	grep -q "^FAIL    root" "$work/out" || fail "install.sh --check didn't run doctor: $(cat "$work/out")"
	[[ ! -e "$work/check-bin/kantel-host" ]] || fail "install.sh --check installed kantel-host"
	echo "ok      install.sh --check runs doctor, which fails without root, and installs nothing"
fi

# Joining installs a service, so it needs root; as anyone else it stops before running kantel-host install.
if [[ "$(id -u)" != 0 ]]; then
	if sh "$github/install.sh" --url https://kantel.invalid --token kth_smoke 2>"$work/err"; then
		fail "install.sh joined without root"
	fi
	grep -q "needs root" "$work/err" || fail "install.sh failed, but not for root: $(cat "$work/err")"
	echo "ok      install.sh needs root to join"
fi

# install-cli.sh: for a user of its own, whose HOME has a package.json without "type" (the commands must still run as
# ES modules), with curl reading the files from disk. It installs kantel alone, then kantel-admin with --admin, then
# again with no flag (an update), which keeps kantel-admin up to date.
cli_home="$work/cli-home"
mkdir -p "$cli_home"
echo '{}' >"$cli_home/package.json"
HOME="$cli_home" sh "$github/install-cli.sh" 2>"$work/err" || fail "install-cli.sh failed: $(cat "$work/err")"
expect "install-cli.sh, then kantel" "$cli_home/.local/bin/kantel" --version
[[ ! -e "$cli_home/.local/bin/kantel-admin" ]] || fail "install-cli.sh installed kantel-admin without --admin"
HOME="$cli_home" sh "$github/install-cli.sh" --admin 2>"$work/err" ||
	fail "install-cli.sh --admin failed: $(cat "$work/err")"
touch -d 2000-01-01 "$cli_home/.local/share/kantel/kantel-admin.mjs"
touch -d 2001-01-01 "$work/before-update"
HOME="$cli_home" sh "$github/install-cli.sh" 2>"$work/err" || fail "install-cli.sh (update) failed: $(cat "$work/err")"
[[ "$cli_home/.local/share/kantel/kantel-admin.mjs" -nt "$work/before-update" ]] ||
	fail "install-cli.sh (update) didn't update the kantel-admin it installed before"
grep -q "isn't on your PATH" "$work/err" || fail "install-cli.sh didn't say ~/.local/bin isn't on the PATH"
expect "install-cli.sh, then kantel" "$cli_home/.local/bin/kantel" --version
expect "install-cli.sh, then kantel-admin" "$cli_home/.local/bin/kantel-admin" --version
[[ -f "$cli_home/.local/share/kantel/console/index.html" ]] || fail "install-cli.sh didn't install the console"
[[ ! -e "$cli_home/.local/share/kantel/console.old" ]] || fail "install-cli.sh left the console it replaced"
console_serves "$cli_home/.local/bin/kantel"
echo "ok      install-cli.sh, then kantel console serves the console through its link alone"

HOME="$cli_home" sh "$github/install-cli.sh" --no-admin --dir "$work/cli-bin" 2>"$work/err" ||
	fail "install-cli.sh --dir failed: $(cat "$work/err")"
expect "install-cli.sh --dir, then kantel" "$work/cli-bin/kantel" --version
[[ ! -e "$work/cli-bin/kantel-admin" ]] || fail "install-cli.sh --no-admin installed kantel-admin"

# A file that doesn't match SHA256SUMS must not be installed.
printf 'x' >>"$work/bad/kantel.js"
if KANTEL_RELEASE_URL="file://$work/bad" HOME="$work/cli-bad" sh "$github/install-cli.sh" 2>"$work/err"; then
	fail "install-cli.sh installed a kantel.js whose SHA-256 doesn't match"
fi
grep -q "SHA256SUMS says" "$work/err" || fail "install-cli.sh failed, but not on the checksum: $(cat "$work/err")"
[[ ! -e "$work/cli-bad/.local/bin/kantel" ]] || fail "install-cli.sh left a kantel that doesn't match"
echo "ok      install-cli.sh refuses a file that doesn't match SHA256SUMS"

# An older Node.js can't run the commands.
printf '#!/bin/sh\necho 20.18.0\n' >"$work/shim/node"
chmod 755 "$work/shim/node"
if PATH="$work/shim:$PATH" HOME="$work/cli-old" sh "$github/install-cli.sh" 2>"$work/err"; then
	fail "install-cli.sh installed for Node.js 20"
fi
grep -q "needs Node.js 22 or later" "$work/err" || fail "install-cli.sh failed, but not on Node's version: $(cat "$work/err")"
echo "ok      install-cli.sh needs Node.js 22 or later"
