#!/usr/bin/env bash
# github-release.sh [--dry-run] <version> [out]: makes Kantel's GitHub Release v<version>, at this checkout's commit,
# with the files pack.sh wrote to out/github (default dist/release/github): kantel-host for Linux x86_64 and arm64,
# kantel.js, kantel-admin.js, kantel-console.tar.gz, install.sh, install-cli.sh and SHA256SUMS.
#
# A version without a prerelease part (0.1.0) is marked the latest release, so
# https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh, the host join command Kantel prints,
# and releases/latest/download/install-cli.sh, the commands' installer, serve it. A prerelease (0.2.0-rc.1) is marked a prerelease and never the latest; install it with
# `install.sh --version 0.2.0-rc.1`. If the release exists already with every file, nothing changes; if it exists
# without some of them (a run that stopped part way), the files are uploaded again, replacing those there.
#
# It needs gh, signed in with permission to write the repository's contents (GH_TOKEN in the workflow). --dry-run
# only prints what it would do, and needs neither gh nor a token.
set -euo pipefail

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
	dry_run=1
	shift
fi
version=${1:?usage: github-release.sh [--dry-run] <version> [out]}
root=$(cd "$(dirname "$0")/../.." && pwd)
out=${2:-$root/dist/release}
repo=${GITHUB_REPOSITORY:-lleverage-ai/kantel}
tag="v$version"
commit=$(git -C "$root" rev-parse HEAD)
files=(kantel-host-linux-amd64 kantel-host-linux-arm64 kantel.js kantel-admin.js kantel-console.tar.gz install.sh
	install-cli.sh SHA256SUMS)

for file in "${files[@]}"; do
	[[ -f "$out/github/$file" ]] || {
		echo "github-release.sh: no $out/github/$file; run pack.sh first" >&2
		exit 1
	}
done
for file in install.sh install-cli.sh; do
	grep -q "^KANTEL_RELEASE_VERSION=\"$version\"$" "$out/github/$file" || {
		echo "github-release.sh: $out/github/$file isn't $version's; run pack.sh $version" >&2
		exit 1
	}
done

flags=(--latest)
[[ "$version" == *-* ]] && flags=(--prerelease --latest=false)

base="https://github.com/$repo/releases/download/$tag"
notes=$(
	cat <<EOF
Kantel $version.

**Use sandboxes**: install the \`kantel\` command, and the operator's \`kantel-admin\`, for yourself (Linux or macOS, with
Node.js 22 or later; no sudo). This installs this release; \`releases/latest/download/install-cli.sh\` installs the latest:

\`\`\`sh
curl -fsSL $base/install-cli.sh | sh
\`\`\`

It installs the console's files from \`kantel-console.tar.gz\` too: \`kantel console\` serves them on 127.0.0.1, so the
console's code comes with this release, not from a gateway.

**Add a host** (Linux, x86_64 or arm64, with /dev/kvm for microVMs): make a join token on the console's Hosts page or
with \`kantel-admin host add\`, then run the command it prints on the machine. To install this release in particular:

\`\`\`sh
curl -fsSL $base/install.sh | sudo sh -s -- --url https://kantel.example.com --token kth_...
\`\`\`

**Operate a self-hosted Kantel**: \`kantel-admin\` comes with the command above. For it alone, system-wide:

\`\`\`sh
sudo curl -fsSLo /usr/local/bin/kantel-admin $base/kantel-admin.js
sudo chmod 755 /usr/local/bin/kantel-admin
\`\`\`

\`SHA256SUMS\` has every file's SHA-256, and GitHub has a build provenance attestation for each:
\`gh attestation verify <file> --repo $repo\`.
EOF
)

if [[ "$dry_run" == 1 ]]; then
	echo "dry run: gh release create $tag --repo $repo --target $commit --title 'Kantel $version' ${flags[*]}"
	for file in "${files[@]}"; do echo "  $file"; done
	echo "--- notes"
	echo "$notes"
	exit 0
fi

if existing=$(gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name' 2>/dev/null); then
	missing=()
	for file in "${files[@]}"; do
		grep -qx "$file" <<<"$existing" || missing+=("$file")
	done
	if [[ ${#missing[@]} == 0 ]]; then
		echo "skip    $tag: the release has every file already"
		exit 0
	fi
	echo "upload  $tag: the release has no ${missing[*]}; uploading every file again"
	(cd "$out/github" && gh release upload "$tag" --repo "$repo" --clobber "${files[@]}")
else
	echo "create  $tag at $commit (${flags[*]})"
	(cd "$out/github" && gh release create "$tag" --repo "$repo" --target "$commit" --title "Kantel $version" \
		--notes "$notes" "${flags[@]}" "${files[@]}")
fi
echo "https://github.com/$repo/releases/tag/$tag"
