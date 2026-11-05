package images

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// FetchFirecracker installs Firecracker's release version (such as v1.17.0) at dst from GitHub, checked against the
// release's SHA256SUMS; one that already reports the version is kept. The binary is replaced in one rename, so a VM
// running on the old one keeps its process. Every request and the version check are ctx's: one that ends leaves the
// installed binary as it is.
func FetchFirecracker(ctx context.Context, dst, version string) error {
	if out, err := exec.CommandContext(ctx, dst, "--version").Output(); err == nil && strings.Contains(string(out), strings.TrimPrefix(version, "v")) {
		fmt.Printf("  firecracker %s: up to date\n", version)
		return nil
	}
	rel := FirecrackerReleaseOf(version)
	sums, err := httpGet(ctx, rel.SumsURL)
	if err != nil {
		return err
	}
	sumText, err := io.ReadAll(sums)
	sums.Close()
	if err != nil {
		return err
	}
	want := strings.Fields(string(sumText))
	if len(want) == 0 {
		return fmt.Errorf("%s: no digest", rel.SumsURL)
	}
	body, err := httpGet(ctx, rel.URL)
	if err != nil {
		return err
	}
	defer body.Close()
	return rel.Install(body, want[0], dst)
}

// FirecrackerRelease is where one Firecracker release is for this machine: its archive, the archive's digest file, and
// the binary in it.
type FirecrackerRelease struct {
	Version, URL, SumsURL, Member string
}

// FirecrackerReleaseOf is version's release (such as v1.17.0) on GitHub, for this machine's architecture.
func FirecrackerReleaseOf(version string) FirecrackerRelease {
	arch := "x86_64"
	if runtime.GOARCH == "arm64" {
		arch = "aarch64"
	}
	base := "https://github.com/firecracker-microvm/firecracker/releases/download/" + version + "/"
	name := fmt.Sprintf("firecracker-%s-%s.tgz", version, arch)
	return FirecrackerRelease{
		Version: version, URL: base + name, SumsURL: base + name + ".sha256.txt",
		Member: fmt.Sprintf("release-%s-%s/firecracker-%s-%s", version, arch, version, arch),
	}
}

// Install reads the release's archive from archive, checks it against want (its SHA-256, hex) and puts its binary at
// dst, replaced in one rename.
func (r FirecrackerRelease) Install(archive io.Reader, want, dst string) error {
	raw, err := io.ReadAll(archive)
	if err != nil {
		return err
	}
	got := sha256.Sum256(raw)
	if !strings.EqualFold(want, hex.EncodeToString(got[:])) {
		return fmt.Errorf("%s: digest doesn't match the release's", filepath.Base(r.URL))
	}
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("%s has no %s", filepath.Base(r.URL), r.Member)
		}
		if err != nil {
			return err
		}
		if h.Name != r.Member {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		out, err := os.OpenFile(dst+".part", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, tr); err != nil {
			out.Close()
			return err
		}
		if err := out.Close(); err != nil {
			return err
		}
		fmt.Printf("  firecracker %s\n", r.Version)
		return os.Rename(dst+".part", dst)
	}
}

// RecordedSHA256 is the digest Fetch recorded beside dst (dst.sha256-source) when it downloaded it.
func RecordedSHA256(dst string) (string, error) { return recordedSHA256(dst) }

// HTTPGet fetches u, refusing any answer but 200.
func HTTPGet(ctx context.Context, u string) (io.ReadCloser, error) { return httpGet(ctx, u) }

// FirecrackerVersionOf is the version a Firecracker binary reports (such as v1.17.0), or "" when it doesn't run.
func FirecrackerVersionOf(path string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "--version").Output()
	if err != nil {
		return ""
	}
	// "Firecracker v1.17.0", then the snapshot versions it reads.
	for _, f := range strings.Fields(string(out)) {
		if strings.HasPrefix(f, "v") && strings.Contains(f, ".") {
			return f
		}
	}
	return ""
}
