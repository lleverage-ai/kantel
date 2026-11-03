#!/usr/bin/env bash
# smoke.sh <version> [out]: checks what pack.sh wrote to out (default dist/release) before anything is published:
#   - SHA256SUMS matches the release's files, and lists each of them;
#   - kantel-host (this machine's architecture), kantel-admin.js and the npm package's kantel all print <version>;
#   - install.sh, pointed at out/github, downloads this machine's kantel-host, checks it against SHA256SUMS and installs
#     it (--no-join), refuses a binary whose SHA-256 doesn't match, hands its options on to `kantel-host install`
#     (with a stand-in binary), and refuses to join without root.
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
for file in kantel-host-linux-amd64 kantel-host-linux-arm64 kantel-admin.js install.sh; do
	grep -q "  $file\$" "$github/SHA256SUMS" || fail "SHA256SUMS has no line for $file"
done

case "$(uname -m)" in
	x86_64) arch=amd64 ;;
	aarch64) arch=arm64 ;;
	*) fail "runs on x86_64 or arm64, not $(uname -m)" ;;
esac
expect "kantel-host-linux-$arch" "$github/kantel-host-linux-$arch" version
expect "kantel-admin.js" node "$github/kantel-admin.js" version
tar -xzf "$out"/npm/kantel-*.tgz -C "$work"
expect "kantel (npm)" node "$work/package/kantel.js" --version

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

# Joining installs a service, so it needs root; as anyone else it stops before running kantel-host install.
if [[ "$(id -u)" != 0 ]]; then
	if sh "$github/install.sh" --url https://kantel.invalid --token kth_smoke 2>"$work/err"; then
		fail "install.sh joined without root"
	fi
	grep -q "needs root" "$work/err" || fail "install.sh failed, but not for root: $(cat "$work/err")"
	echo "ok      install.sh needs root to join"
fi
