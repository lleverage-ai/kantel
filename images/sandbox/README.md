# images/sandbox

The container tier's image: what a session's container runs when a command needs real binaries (`git` writes,
`python3`, `npm`, `make`, ...). Built from `Dockerfile` here; CI builds and tests it in `.github/workflows/sandbox-image.yml`.

It runs commands as `sandbox` (uid 1000), with `HOME=/workspace`. The container tier decides the network: none by
default, or the vault's egress proxy (`targets/selfhosted/sandbox/README.md`). Nothing secret is in the image.

## What's in it

The baseline an agent reaches for without asking. Debian packages come from the base image's release (trixie); the
rest are pinned by version and checksum in the Dockerfile.

| Group | Tools | Why |
| --- | --- | --- |
| Shell and core | `bash`, coreutils, findutils, `grep`, `sed`, `gawk`, `diffutils`, `patch`, `less`, `procps`, `util-linux`, `tree`, `bc`, `file` | Scripts agents write assume a full GNU userland. |
| Fetching | `curl`, `wget`, `git`, `git-lfs`, `openssh-client`, `rsync`, `gh` | Clones, downloads and GitHub, through the egress proxy. |
| Archives | `tar`, `gzip`, `bzip2`, `xz`, `zstd`, `zip`, `unzip` | Release tarballs and zips. |
| Search and data | `ripgrep` (`rg`), `fd`, `jq`, `sqlite3` | Fast search and structured data. |
| JavaScript | `node` 24, `npm`, `pnpm`, `bun` (and `bunx`) | Every common JS toolchain; `npm install -g` goes to `~/.local`. |
| Python | `python3` 3.13, `python`, `pip`, `venv`, headers (`python3-dev`) | `pip install` works without a virtualenv (`PIP_BREAK_SYSTEM_PACKAGES`), into `~/.local`. |
| Native builds | `build-essential` (`gcc`, `g++`, `make`, libc headers), `pkg-config` | Native npm and pip packages, and `make`. |
| Documents and images | `pandoc`, `poppler-utils` (`pdftotext`, `pdftoppm`, `pdfinfo`), `qpdf`, `imagemagick` (`convert`, `magick`) | Artefact work: Markdown to DOCX/HTML, reading and splitting PDFs, resizing images. |
| Issue tracking | `linear-cli` | Linear from a session. |

## Left out, on purpose

Each would add more than it's worth for most sessions; a session that needs one installs it, or a team builds its
own image `FROM` this one.

- **LibreOffice** (about 600 MB unpacked): Office-to-PDF conversion. `pandoc` covers Markdown/HTML to DOCX.
- **A TeX distribution** (300 MB to several GB): PDF output from `pandoc`. HTML or DOCX output needs none.
- **ffmpeg** (about 150 MB with its libraries).
- **Go, Rust, Java** toolchains (hundreds of MB each).
- **Browsers**: sessions have their own (`images/browser`).

## Size

The image is about 1.66 GB unpacked and 397 MB compressed (`docker save | gzip -1`). The biggest parts are `pandoc`
(190 MB), the GCC toolchain (about 250 MB with headers) and Perl (pulled in by `git` and `build-essential`). The size
costs only the first pull on a new host: once a host has the image, a container starts in 0.5 to 2 s on a local
Docker host.
