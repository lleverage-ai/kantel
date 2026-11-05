package bundles

import (
	"archive/tar"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// countEntries is how many files, directories and links are under root, root itself not counted.
func countEntries(t *testing.T, root string) int {
	t.Helper()
	n := 0
	err := filepath.WalkDir(root, func(p string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p != root {
			n++
		}
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return n
}

// TestExtractBoundsEntriesAndImpliedDirectories: empty files under deep paths, whose parents only their names imply,
// cost no file bytes, so the entries and the directories they imply are counted, and the extraction is refused
// before it makes more than the most.
func TestExtractBoundsEntriesAndImpliedDirectories(t *testing.T) {
	old := maxExtractEntries
	maxExtractEntries = 100
	defer func() { maxExtractEntries = old }()
	dir := t.TempDir()

	// 10 empty files, each under its own 20 directories: 210 entries, 10 of them in the tar.
	var deep []entry
	for i := range 10 {
		parts := make([]string, 20)
		for j := range parts {
			parts[j] = fmt.Sprintf("d%d_%d", i, j)
		}
		deep = append(deep, entry{name: strings.Join(parts, "/") + "/f"})
	}
	p := filepath.Join(dir, "deep.tar")
	if err := os.WriteFile(p, makeTar(t, deep...), 0o600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "deep")
	err := Extract(p, root, 1<<20)
	if err == nil || !strings.Contains(err.Error(), "more than 100 entries") {
		t.Fatalf("refused for its entries: %v", err)
	}
	if n := countEntries(t, root); n > 100 {
		t.Fatalf("made %d entries, more than the most", n)
	}

	// Many entries in the tar itself, even repeats of one directory, count too.
	var many []entry
	for range 150 {
		many = append(many, entry{name: "./", typ: tar.TypeDir, mode: 0o755})
	}
	p = filepath.Join(dir, "many.tar")
	if err := os.WriteFile(p, makeTar(t, many...), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Extract(p, filepath.Join(dir, "many"), 1<<20); err == nil || !strings.Contains(err.Error(), "entries") {
		t.Fatalf("refused for its entries: %v", err)
	}

	// Up to the most is fine: 4 files under 3 shared directories, and the directories' own entries.
	ok := makeTar(t,
		entry{name: "a/", typ: tar.TypeDir, mode: 0o755},
		entry{name: "a/b/c/one", body: "1"},
		entry{name: "a/b/c/two", body: "2"},
		entry{name: "a/b/three", body: "3"},
		entry{name: "a/four", body: "4"},
	)
	p = filepath.Join(dir, "ok.tar")
	if err := os.WriteFile(p, ok, 0o600); err != nil {
		t.Fatal(err)
	}
	maxExtractEntries = 7 // 5 in the tar, and a/b and a/b/c implied
	root = filepath.Join(dir, "ok")
	if err := Extract(p, root, 1<<20); err != nil {
		t.Fatalf("exactly the most: %v", err)
	}
	if n := countEntries(t, root); n != 7 {
		t.Fatalf("made %d entries", n)
	}
	maxExtractEntries = 6
	if err := Extract(p, filepath.Join(dir, "ok-one-short"), 1<<20); err == nil {
		t.Fatal("one short of what it needs: refused")
	}
}

// TestExtractKeepsLittleOfADirectorysHeader: a directory named again and again, each time with large PAX records,
// is kept once, as its path, mode and time (the last entry's), and the names kept have a most.
func TestExtractKeepsLittleOfADirectorysHeader(t *testing.T) {
	dir := t.TempDir()
	var buf strings.Builder
	tw := tar.NewWriter(&buf)
	big := strings.Repeat("x", 64<<10)
	for i := range 50 {
		mode := int64(0o755)
		if i == 49 {
			mode = 0o555
		}
		hdr := &tar.Header{Name: "d/", Typeflag: tar.TypeDir, Mode: mode, Format: tar.FormatPAX,
			PAXRecords: map[string]string{"comment": big}}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.WriteHeader(&tar.Header{Name: "d/f", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "pax.tar")
	if err := os.WriteFile(p, []byte(buf.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "pax")
	if err := Extract(p, root, 1<<20); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(filepath.Join(root, "d")); err != nil || st.Mode().Perm() != 0o555 {
		t.Fatalf("the last entry's mode, set after its file: %v %v", st, err)
	}
	if b, err := os.ReadFile(filepath.Join(root, "d/f")); err != nil || string(b) != "x" {
		t.Fatalf("its file: %q %v", b, err)
	}
	_ = os.Chmod(filepath.Join(root, "d"), 0o755)

	// The directory names kept until the end have a most.
	old := maxExtractDirBytes
	maxExtractDirBytes = len(filepath.Join(dir, "names", "d0")) * 3
	defer func() { maxExtractDirBytes = old }()
	var dirs []entry
	for i := range 5 {
		dirs = append(dirs, entry{name: fmt.Sprintf("d%d/", i), typ: tar.TypeDir, mode: 0o755})
	}
	p = filepath.Join(dir, "names.tar")
	if err := os.WriteFile(p, makeTar(t, dirs...), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Extract(p, filepath.Join(dir, "names"), 1<<20); err == nil || !strings.Contains(err.Error(), "directory names") {
		t.Fatalf("refused for its directory names: %v", err)
	}
}
