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
	arch := "x86_64"
	if runtime.GOARCH == "arm64" {
		arch = "aarch64"
	}
	base := "https://github.com/firecracker-microvm/firecracker/releases/download/" + version + "/"
	name := fmt.Sprintf("firecracker-%s-%s.tgz", version, arch)
	sums, err := httpGet(ctx, base+name+".sha256.txt")
	if err != nil {
		return err
	}
	sumText, err := io.ReadAll(sums)
	sums.Close()
	if err != nil {
		return err
	}
	want := strings.Fields(string(sumText))
	body, err := httpGet(ctx, base+name)
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(body)
	body.Close()
	if err != nil {
		return err
	}
	got := sha256.Sum256(raw)
	if len(want) == 0 || want[0] != hex.EncodeToString(got[:]) {
		return fmt.Errorf("%s: digest doesn't match the release's", name)
	}
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	member := fmt.Sprintf("release-%s-%s/firecracker-%s-%s", version, arch, version, arch)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("%s has no %s", name, member)
		}
		if err != nil {
			return err
		}
		if h.Name == member {
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
			out.Close()
			fmt.Printf("  firecracker %s\n", version)
			return os.Rename(dst+".part", dst)
		}
	}
}

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
