package hostinfo

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"os/exec"
	"strings"
)

// FirecrackerVersion is the version a Firecracker binary reports (`v1.17.0`, from `firecracker --version`'s first
// line, "Firecracker v1.17.0"); empty when it can't be run.
func FirecrackerVersion(binary string) string {
	out, err := exec.Command(binary, "--version").Output()
	if err != nil {
		return ""
	}
	return parseFirecrackerVersion(string(out))
}

func parseFirecrackerVersion(out string) string {
	first, _, _ := strings.Cut(strings.TrimSpace(out), "\n")
	fields := strings.Fields(first)
	for _, field := range fields {
		if len(field) > 1 && field[0] == 'v' && field[1] >= '0' && field[1] <= '9' {
			return field
		}
	}
	if len(fields) > 0 {
		return fields[len(fields)-1]
	}
	return ""
}

// linuxBanner starts the version string an uncompressed kernel (vmlinux) carries: "Linux version 6.1.102 (...) #1 ...".
var linuxBanner = []byte("Linux version ")

// GuestKernel identifies a guest kernel file: its version from the banner it carries, then `+` and the first 12 hex
// digits of its SHA-256, since two builds of one version needn't restore each other's snapshots
// (`6.1.102+0123456789ab`). Without a banner it is `sha256:` and the prefix; empty when the file can't be read.
func GuestKernel(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	hash := sha256.New()
	version := ""
	// Read in chunks, each searched with the end of the one before it, so a banner across two chunks is found too.
	buf := make([]byte, 1<<20)
	var carry []byte
	for {
		n, err := f.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			hash.Write(chunk)
			if version == "" {
				window := append(carry, chunk...)
				if v, ok := bannerVersion(window); ok {
					version = v
				} else if len(window) > 256 {
					carry = append([]byte{}, window[len(window)-256:]...)
				} else {
					carry = append([]byte{}, window...)
				}
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return ""
		}
	}
	sum := hex.EncodeToString(hash.Sum(nil))[:12]
	if version == "" {
		return "sha256:" + sum
	}
	return version + "+" + sum
}

// bannerVersion finds the kernel's version in b (a banner whose version starts with a digit, not a format string's
// "%s"); false when b has no whole one.
func bannerVersion(b []byte) (string, bool) {
	for {
		at := bytes.Index(b, linuxBanner)
		if at < 0 {
			return "", false
		}
		rest := b[at+len(linuxBanner):]
		end := bytes.IndexAny(rest, " \x00\n")
		if end > 0 && end <= 64 && rest[0] >= '0' && rest[0] <= '9' {
			return string(rest[:end]), true
		}
		b = rest
	}
}
