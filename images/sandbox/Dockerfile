# syntax=docker/dockerfile:1.7
# Harbour container tier: the image a session's container runs (#10). One container per container-tier lease: on
# gVisor (`runsc-kvm`) when self-hosted, with the workspace copied into /workspace and out again. What is in it, and
# why, is in README.md; keep that list in step with this file.
#
# Everything is pinned: base images by index digest, downloaded tools by release and SHA-256, Debian packages by the
# base image's release (trixie). Nothing secret is baked in; credentials reach a sandbox only through the vault egress
# proxy at run time.
#
# linear-cli links libdbus (its keyring support); the sandbox never has a keyring, so it reads its key from the
# environment the egress proxy allows.

ARG NODE_IMAGE=node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
ARG BUN_IMAGE=oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e

FROM ${BUN_IMAGE} AS bun

FROM ${NODE_IMAGE} AS fetch
ARG TARGETARCH
ARG GH_VERSION=2.103.3
ARG GH_SHA256_AMD64=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d
ARG GH_SHA256_ARM64=ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63
ARG LINEAR_CLI_VERSION=0.3.28
ARG LINEAR_CLI_SHA256_AMD64=5af0cac71903dd31f155553e4892280dbd4f0f347536095a963bfa1aeb7c26a3
ARG LINEAR_CLI_SHA256_ARM64=621e29d4be1a70f70bb3157265b43c7b4cec0ed1aa0499a6b6b348b37cbc78a0
# pnpm's npm tarball (architecture-independent), installed from the checked file rather than by name.
ARG PNPM_VERSION=10.34.9
ARG PNPM_SHA256=7e8a946108e7baab119e51d27c24d6178b46545422643dbc91e34e2f1ee32e0f
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*
RUN set -eu; \
	case "${TARGETARCH:-amd64}" in \
		amd64) gh_arch=amd64; gh_sum="$GH_SHA256_AMD64"; lc_arch=x86_64; lc_sum="$LINEAR_CLI_SHA256_AMD64" ;; \
		arm64) gh_arch=arm64; gh_sum="$GH_SHA256_ARM64"; lc_arch=aarch64; lc_sum="$LINEAR_CLI_SHA256_ARM64" ;; \
		*) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
	esac; \
	mkdir -p /out; cd /tmp; \
	curl -fsSLo gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${gh_arch}.tar.gz"; \
	echo "${gh_sum}  gh.tar.gz" | sha256sum -c -; \
	tar -xzf gh.tar.gz; \
	install -m 0755 "gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /out/gh; \
	curl -fsSLo linear-cli.tar.gz "https://github.com/nesszer/linear-cli/releases/download/v${LINEAR_CLI_VERSION}/linear-cli-${lc_arch}-unknown-linux-gnu.tar.gz"; \
	echo "${lc_sum}  linear-cli.tar.gz" | sha256sum -c -; \
	tar -xzf linear-cli.tar.gz; \
	install -m 0755 linear-cli /out/linear-cli; \
	curl -fsSLo pnpm.tgz "https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz"; \
	echo "${PNPM_SHA256}  pnpm.tgz" | sha256sum -c -; \
	install -m 0644 pnpm.tgz /out/pnpm.tgz

FROM ${NODE_IMAGE}
# The agent baseline (README.md lists each with what it's for). Grouped: shell and core tools; fetching and archives;
# search and text; Python; building native code; documents and images. Left out on purpose, for size: LibreOffice,
# ffmpeg, a TeX distribution, browsers (sessions have their own), Go, Rust and Java toolchains.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash bc ca-certificates coreutils diffutils file findutils gawk grep less libdbus-1-3 patch procps sed tree \
		util-linux \
		curl git git-lfs openssh-client rsync wget \
		bzip2 unzip xz-utils zip zstd \
		fd-find jq ripgrep sqlite3 \
		python3 python3-dev python3-pip python3-venv \
		build-essential pkg-config \
		imagemagick pandoc poppler-utils qpdf \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=fetch /out/gh /out/linear-cli /usr/local/bin/
COPY --from=fetch /out/pnpm.tgz /tmp/pnpm.tgz
# The node image's uid 1000 user becomes `sandbox`, the user the container tier runs commands as, with its home in
# the workspace so tools that write dotfiles write them where the tier can see them. /home/sandbox is for a tier that
# keeps caches out of the workspace.
# pip may install into the user's site-packages without a virtualenv (PEP 668 would refuse it otherwise), and npm's
# global prefix is the user's ($HOME/.local, beside pip's), so `pip install x` and `npm install -g x` work without root
# and land on PATH.
RUN set -eu; \
	ln -s /usr/local/bin/bun /usr/local/bin/bunx; \
	npm install -g /tmp/pnpm.tgz --no-fund --no-audit; \
	rm -f /tmp/pnpm.tgz; \
	npm cache clean --force; \
	ln -s /usr/bin/python3 /usr/local/bin/python; \
	usermod -l sandbox -d /workspace node; \
	groupmod -n sandbox node; \
	mkdir -p /workspace /home/sandbox; \
	chown 1000:1000 /workspace /home/sandbox; \
	bun --version; node --version; npm --version; pnpm --version; git --version; gh --version; jq --version; \
	rg --version; python3 --version; pip --version; linear-cli --version; gcc --version; make --version; \
	convert -version; pandoc --version; pdftotext -v; sqlite3 --version; fd --version
ENV HOME=/workspace \
	PIP_BREAK_SYSTEM_PACKAGES=1 \
	PIP_DISABLE_PIP_VERSION_CHECK=1 \
	NPM_CONFIG_PREFIX=/workspace/.local \
	PATH=/workspace/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER 1000:1000
WORKDIR /workspace
CMD ["sh"]
