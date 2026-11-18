package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// manifestCmd writes <dir>/manifest.json for the host images in dir, as `install` reads it from Kantel (the
// gateway's /v1/hosts/images) or from --images. A file shipped gzipped (name.gz) is listed under its plain name with
// gzip set; its checksum is the compressed file's, which is what install verifies as it downloads.
func manifestCmd(args []string) error {
	fs := newFlags("manifest")
	rest, err := fs.parseInterspersed(args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		if len(rest) == 0 {
			return usageErrorf("manifest", "manifest needs <dir>")
		}
		return usageErrorf("manifest", "manifest takes one <dir>, and got %d", len(rest))
	}
	dir := rest[0]
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	known := func(name string) bool {
		for _, prefix := range []string{"vmlinux-", "sandbox-", "isolate-", "kantel-isolate-", "kantel-host-", "kantel-guest-"} {
			if strings.HasPrefix(name, prefix) {
				return true
			}
		}
		return false
	}
	manifest := ImageManifest{Version: version, Files: map[string]ImageFile{}}
	for _, e := range entries {
		file := e.Name()
		if e.IsDir() || strings.HasSuffix(file, ".config") || strings.HasSuffix(file, ".part") {
			continue
		}
		name, gz := file, false
		// A tarball (isolate-assets-<arch>.tar.gz) is fetched as it is and unpacked into a directory; any other .gz is
		// one file, unpacked as it downloads.
		if strings.HasSuffix(file, ".gz") && !strings.HasSuffix(file, ".tar.gz") {
			name, gz = strings.TrimSuffix(file, ".gz"), true
		}
		if !known(name) {
			continue
		}
		// The kernel build names it vmlinux-x86_64; install asks by Go's architecture names.
		name = strings.NewReplacer("x86_64", "amd64", "aarch64", "arm64").Replace(name)
		if _, plain := manifest.Files[name]; plain && !gz {
			continue // the gzipped one wins
		}
		path := filepath.Join(dir, file)
		sum, err := fileSHA256(path)
		if err != nil {
			return err
		}
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		manifest.Files[name] = ImageFile{Path: file, SHA256: sum, Size: info.Size(), Gzip: gz}
	}
	if len(manifest.Files) == 0 {
		return fmt.Errorf("no host images in %s (vmlinux-<arch>, sandbox-<arch>.ext4, isolate-<arch>.ext4, kantel-isolate-<arch>)", dir)
	}
	out, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), append(out, '\n'), 0o644); err != nil {
		return err
	}
	names := make([]string, 0, len(manifest.Files))
	for name := range manifest.Files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		f := manifest.Files[name]
		fmt.Printf("%-28s %-36s %12d  %s\n", name, f.Path, f.Size, f.SHA256[:12])
	}
	return nil
}
