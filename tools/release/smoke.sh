#!/usr/bin/env bash
# smoke.sh <version> [out]: checks what pack.sh wrote to out (default dist/release) before anything is published:
#   - SHA256SUMS matches the release's files, and lists each of them;
#   - kantel-host, kantel and kantel-admin (this machine's architecture) print <version>, and the macOS binaries are
#     Mach-O ones;
#   - install.sh, pointed at out/github, downloads this machine's kantel-host, checks it against SHA256SUMS and installs
#     it (--no-join), refuses a binary whose SHA-256 doesn't match, hands its options on to `kantel-host install`
#     (with a stand-in binary), and refuses to join without root;
#   - install-cli.sh, pointed at out/github with a HOME of its own, installs kantel and kantel-admin that print
#     <version>, again over the first (an update), over a Node.js release's install, and into --dir; it refuses a
#     binary whose SHA-256 doesn't match, and a link it didn't make;
#   - `kantel update`, pointed at out/github, replaces kantel (and kantel-admin beside it) with the release's, and
#     refuses a binary whose SHA-256 doesn't match.
# Runs on Linux x86_64 or arm64, such as the release workflow's runner, as a user other than root. kantel-admin is
# checked when apps/cli/cmd/kantel-admin is there (pack.sh skips it until it is).
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

admin=0
[[ -d "$root/apps/cli/cmd/kantel-admin" ]] && admin=1
platforms=(linux-amd64 linux-arm64 darwin-amd64 darwin-arm64)
files=(kantel-host-linux-amd64 kantel-host-linux-arm64 install.sh install-cli.sh)
for platform in "${platforms[@]}"; do
	files+=("kantel-$platform")
	[[ "$admin" == 1 ]] && files+=("kantel-admin-$platform")
done
(cd "$github" && sha256sum --check --strict SHA256SUMS) || fail "SHA256SUMS doesn't match the files"
for file in "${files[@]}"; do
	[[ -f "$github/$file" ]] || fail "there is no $file"
	grep -q "  $file\$" "$github/SHA256SUMS" || fail "SHA256SUMS has no line for $file"
done
for file in "$github"/*-darwin-*; do
	# A 64-bit Mach-O binary starts cf fa ed fe.
	[[ "$(head -c 4 "$file" | od -An -tx1 | tr -d ' \n')" == cffaedfe ]] || fail "$(basename "$file") isn't a macOS binary"
done
echo "ok      the macOS binaries are Mach-O"

case "$(uname -m)" in
	x86_64) arch=amd64 ;;
	aarch64) arch=arm64 ;;
	*) fail "runs on x86_64 or arm64, not $(uname -m)" ;;
esac
expect "kantel-host-linux-$arch" "$github/kantel-host-linux-$arch" version
expect "kantel-linux-$arch" "$github/kantel-linux-$arch" --version
expect "kantel-linux-$arch version" "$github/kantel-linux-$arch" version
[[ "$admin" == 1 ]] && expect "kantel-admin-linux-$arch" "$github/kantel-admin-linux-$arch" --version

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

# --dry-run runs the downloaded binary's plan (install's options, only ever a dry run) from the temporary directory, and installs nothing.
rm -f "$work/args"
PATH="$work/shim:$PATH" KANTEL_RELEASE_URL="file://$work/fake" KANTEL_BIN_DIR="$work/dry-bin" \
	sh "$github/install.sh" --url https://kantel.invalid --dry-run --token kth_smoke >"$work/out" 2>&1 ||
	fail "install.sh --dry-run failed with a stand-in kantel-host: $(cat "$work/out")"
[[ "$(tr '\n' ' ' <"$work/args")" == "plan --url https://kantel.invalid --dry-run --token kth_smoke " ]] ||
	fail "install.sh --dry-run ran kantel-host with: $(tr '\n' ' ' <"$work/args")"
[[ ! -e "$work/dry-bin/kantel-host" ]] || fail "install.sh --dry-run installed kantel-host"
echo "ok      install.sh --dry-run runs kantel-host plan and installs nothing"

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

# install-cli.sh: for a user of its own, with curl reading the files from disk. It installs kantel alone, then
# kantel-admin with --admin, then again with no flag (an update), which keeps kantel-admin up to date.
cli_home="$work/cli-home"
mkdir -p "$cli_home"
HOME="$cli_home" sh "$github/install-cli.sh" 2>"$work/err" || fail "install-cli.sh failed: $(cat "$work/err")"
expect "install-cli.sh, then kantel" "$cli_home/.local/bin/kantel" --version
[[ -f "$cli_home/.local/bin/kantel" && ! -L "$cli_home/.local/bin/kantel" ]] || fail "install-cli.sh didn't install a binary"
[[ ! -e "$cli_home/.local/bin/kantel-admin" ]] || fail "install-cli.sh installed kantel-admin without --admin"
grep -q "isn't on your PATH" "$work/err" || fail "install-cli.sh didn't say ~/.local/bin isn't on the PATH"
grep -q "fish_add_path $cli_home/.local/bin" "$work/err" || fail "install-cli.sh didn't say how to add it in fish"
if [[ "$admin" == 1 ]]; then
	HOME="$cli_home" sh "$github/install-cli.sh" --admin 2>"$work/err" ||
		fail "install-cli.sh --admin failed: $(cat "$work/err")"
	expect "install-cli.sh --admin, then kantel-admin" "$cli_home/.local/bin/kantel-admin" --version
	touch -d 2000-01-01 "$cli_home/.local/bin/kantel-admin"
fi
touch -d 2000-01-01 "$cli_home/.local/bin/kantel"
touch -d 2001-01-01 "$work/before-update"
HOME="$cli_home" sh "$github/install-cli.sh" 2>"$work/err" || fail "install-cli.sh (update) failed: $(cat "$work/err")"
[[ "$cli_home/.local/bin/kantel" -nt "$work/before-update" ]] || fail "install-cli.sh (update) didn't update kantel"
if [[ "$admin" == 1 ]]; then
	[[ "$cli_home/.local/bin/kantel-admin" -nt "$work/before-update" ]] ||
		fail "install-cli.sh (update) didn't update the kantel-admin it installed before"
	expect "install-cli.sh (update), then kantel-admin" "$cli_home/.local/bin/kantel-admin" --version
fi
expect "install-cli.sh (update), then kantel" "$cli_home/.local/bin/kantel" --version

HOME="$cli_home" sh "$github/install-cli.sh" --no-admin --dir "$work/cli-bin" 2>"$work/err" ||
	fail "install-cli.sh --dir failed: $(cat "$work/err")"
expect "install-cli.sh --dir, then kantel" "$work/cli-bin/kantel" --version
[[ ! -e "$work/cli-bin/kantel-admin" ]] || fail "install-cli.sh --no-admin installed kantel-admin"

# Over a Node.js release's install: ~/.local/bin/kantel a link to ~/.local/share/kantel/kantel.mjs. The binary takes
# the link's place and the .mjs goes.
node_home="$work/node-home"
mkdir -p "$node_home/.local/share/kantel" "$node_home/.local/bin"
printf '#!/usr/bin/env node\n' >"$node_home/.local/share/kantel/kantel.mjs"
ln -s "$node_home/.local/share/kantel/kantel.mjs" "$node_home/.local/bin/kantel"
HOME="$node_home" sh "$github/install-cli.sh" 2>"$work/err" ||
	fail "install-cli.sh over a Node.js install failed: $(cat "$work/err")"
[[ ! -L "$node_home/.local/bin/kantel" ]] || fail "install-cli.sh left the Node.js release's link"
[[ ! -e "$node_home/.local/share/kantel" ]] || fail "install-cli.sh left the Node.js release's files"
expect "install-cli.sh over a Node.js install, then kantel" "$node_home/.local/bin/kantel" --version
echo "ok      install-cli.sh replaces a Node.js release's install"

# A link it didn't make is left alone.
mkdir -p "$work/other-bin"
ln -s /bin/true "$work/other-bin/kantel"
if HOME="$work/other-home" sh "$github/install-cli.sh" --dir "$work/other-bin" 2>"$work/err"; then
	fail "install-cli.sh replaced a link it didn't make"
fi
grep -q "that this script didn't make" "$work/err" || fail "install-cli.sh failed, but not on the link: $(cat "$work/err")"
echo "ok      install-cli.sh leaves a link it didn't make alone"

# A binary that doesn't match SHA256SUMS must not be installed.
printf 'x' >>"$work/bad/kantel-linux-$arch"
if KANTEL_RELEASE_URL="file://$work/bad" HOME="$work/cli-bad" sh "$github/install-cli.sh" 2>"$work/err"; then
	fail "install-cli.sh installed a kantel whose SHA-256 doesn't match"
fi
grep -q "SHA256SUMS says" "$work/err" || fail "install-cli.sh failed, but not on the checksum: $(cat "$work/err")"
[[ ! -e "$work/cli-bad/.local/bin/kantel" ]] || fail "install-cli.sh left a kantel that doesn't match"
echo "ok      install-cli.sh refuses a binary that doesn't match SHA256SUMS"

# kantel update, from the release's files on disk: up to date, then --force replaces kantel (and kantel-admin beside
# it) through a link, atomically, and refuses a binary that doesn't match SHA256SUMS.
up="$work/update"
mkdir -p "$up/real" "$up/bin"
cp "$github/kantel-linux-$arch" "$up/real/kantel"
[[ "$admin" == 1 ]] && cp "$github/kantel-admin-linux-$arch" "$up/real/kantel-admin"
ln -s "$up/real/kantel" "$up/bin/kantel"
got=$(KANTEL_RELEASE_URL="file://$github" "$up/bin/kantel" update 2>"$work/err") ||
	fail "kantel update failed: $(cat "$work/err")"
[[ "$got" == "kantel $version is up to date." ]] || fail "kantel update said '$got'"
touch -d 2000-01-01 "$up/real/kantel"
KANTEL_RELEASE_URL="file://$github" "$up/bin/kantel" update --force >"$work/out" 2>"$work/err" ||
	fail "kantel update --force failed: $(cat "$work/err")"
[[ "$up/real/kantel" -nt "$work/before-update" && -L "$up/bin/kantel" ]] || fail "kantel update didn't replace kantel"
grep -q "Updated kantel to $version: $up/real/kantel" "$work/out" || fail "kantel update said: $(cat "$work/out")"
if [[ "$admin" == 1 ]]; then
	grep -q "Updated kantel-admin to $version" "$work/out" || fail "kantel update didn't update kantel-admin"
fi
expect "kantel update --force, then kantel" "$up/bin/kantel" --version
[[ -z "$(find "$up" -name '.kantel-update-*')" ]] || fail "kantel update left a temporary file"
touch -d 2000-01-01 "$up/real/kantel"
if KANTEL_RELEASE_URL="file://$work/bad" "$up/bin/kantel" update --force 2>"$work/err" >/dev/null; then
	fail "kantel update installed a kantel whose SHA-256 doesn't match"
fi
grep -q "SHA256SUMS says" "$work/err" || fail "kantel update failed, but not on the checksum: $(cat "$work/err")"
[[ ! "$up/real/kantel" -nt "$work/before-update" ]] || fail "kantel update replaced kantel with a bad binary"
echo "ok      kantel update replaces kantel, and refuses a binary that doesn't match SHA256SUMS"
