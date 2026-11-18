package guest

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// entry is one tar entry for a test archive.
type entry struct {
	name     string
	kind     byte
	body     string
	link     string
	mode     int64
	modified time.Time
}

func writeTar(t *testing.T, entries ...entry) string {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		mode := e.mode
		if mode == 0 {
			mode = 0o644
			if e.kind == tar.TypeDir {
				mode = 0o755
			}
		}
		h := &tar.Header{Name: e.name, Typeflag: e.kind, Mode: mode, Linkname: e.link, ModTime: e.modified, Format: tar.FormatPAX}
		if e.kind == tar.TypeXGlobalHeader {
			h = &tar.Header{Typeflag: e.kind, PAXRecords: map[string]string{"comment": e.body}, Format: tar.FormatPAX}
		}
		if e.kind == tar.TypeReg {
			h.Size = int64(len(e.body))
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if e.kind == tar.TypeReg {
			if _, err := io.WriteString(tw, e.body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "a.tar")
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// A tar of directories, files and an inside link is written out under the target, made if missing, with its modes
// (never setuid or setgid) and times; an existing file is replaced, not written through.
func TestExtractTarWritesTheArchive(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "work", "deep")
	when := time.Date(2025, 3, 1, 12, 0, 0, 0, time.UTC)
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	// An old file whose inode a hard link elsewhere shares: replacing it mustn't change the other name's bytes.
	if err := os.WriteFile(filepath.Join(target, "a.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(target, "a.txt"), filepath.Join(root, "elsewhere")); err != nil {
		t.Fatal(err)
	}
	archive := writeTar(t,
		entry{name: "./", kind: tar.TypeDir},
		entry{name: "a.txt", kind: tar.TypeReg, body: "hello", mode: 0o4755, modified: when},
		entry{name: "dir/", kind: tar.TypeDir, mode: 0o750, modified: when},
		entry{name: "dir/b.txt", kind: tar.TypeReg, body: "inside"},
		entry{name: "implied/c.txt", kind: tar.TypeReg, body: "no dir entry"},
		entry{name: "dir/to-a", kind: tar.TypeSymlink, link: "../a.txt"},
		entry{kind: tar.TypeXGlobalHeader, body: "made by a test"},
	)
	if err := ExtractTar(archive, target, -1, -1); err != nil {
		t.Fatal(err)
	}
	read := func(rel string) string {
		t.Helper()
		b, err := os.ReadFile(filepath.Join(target, rel))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	if read("a.txt") != "hello" || read("dir/b.txt") != "inside" || read("implied/c.txt") != "no dir entry" || read("dir/to-a") != "hello" {
		t.Fatal("the archive's files")
	}
	if b, _ := os.ReadFile(filepath.Join(root, "elsewhere")); string(b) != "old" {
		t.Fatalf("written through an existing file's inode: %q", b)
	}
	info, _ := os.Stat(filepath.Join(target, "a.txt"))
	if info.Mode() != 0o755 || !info.ModTime().Equal(when) {
		t.Fatalf("a.txt: %v, %v", info.Mode(), info.ModTime())
	}
	info, _ = os.Stat(filepath.Join(target, "dir"))
	if info.Mode().Perm() != 0o750 || !info.ModTime().Equal(when) {
		t.Fatalf("dir: %v, %v", info.Mode(), info.ModTime())
	}
}

// What would leave the target, or isn't a file, directory or link, is refused: an archive refusal, so the agent answers
// 400.
func TestExtractTarRefuses(t *testing.T) {
	for name, entries := range map[string][]entry{
		"absolute":          {{name: "/etc/passwd", kind: tar.TypeReg, body: "x"}},
		"climbing":          {{name: "a/../../x", kind: tar.TypeReg, body: "x"}},
		"absolute link":     {{name: "l", kind: tar.TypeSymlink, link: "/etc"}},
		"climbing link":     {{name: "a/l", kind: tar.TypeSymlink, link: "../../x"}},
		"through a link":    {{name: "l", kind: tar.TypeSymlink, link: "d"}, {name: "l/x", kind: tar.TypeReg, body: "x"}},
		"replacing a link":  {{name: "l", kind: tar.TypeSymlink, link: "d"}, {name: "l", kind: tar.TypeReg, body: "x"}},
		"hard link":         {{name: "a", kind: tar.TypeReg, body: "x"}, {name: "b", kind: tar.TypeLink, link: "a"}},
		"device":            {{name: "d", kind: tar.TypeChar}},
		"fifo":              {{name: "f", kind: tar.TypeFifo}},
		"file on directory": {{name: "d/", kind: tar.TypeDir}, {name: "d", kind: tar.TypeReg, body: "x"}},
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(root, "t")
			err := ExtractTar(writeTar(t, entries...), target, -1, -1)
			var refused *errArchive
			if !errors.As(err, &refused) {
				t.Fatalf("not refused: %v", err)
			}
			if _, err := os.Lstat(filepath.Join(root, "x")); !errors.Is(err, fs.ErrNotExist) {
				t.Fatal("something was written outside the target")
			}
		})
	}
}

// A link already in the target is never followed, whatever the archive (which sits in the sandbox, and could have
// changed since Kantel checked it) says: an entry under it is refused, and one at it replaces the link.
func TestExtractTarNeverFollowsALinkThere(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(root, "outside")
	target := filepath.Join(root, "t")
	for _, dir := range []string{outside, target} {
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(target, "out")); err != nil {
		t.Fatal(err)
	}
	err := ExtractTar(writeTar(t, entry{name: "out/x", kind: tar.TypeReg, body: "x"}), target, -1, -1)
	var refused *errArchive
	if !errors.As(err, &refused) {
		t.Fatalf("through a link: %v", err)
	}
	if err := ExtractTar(writeTar(t, entry{name: "out", kind: tar.TypeReg, body: "x"}), target, -1, -1); err != nil {
		t.Fatal(err)
	}
	if names, _ := os.ReadDir(outside); len(names) != 0 {
		t.Fatalf("%d written outside", len(names))
	}
	if info, err := os.Lstat(filepath.Join(target, "out")); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("the link wasn't replaced: %v", err)
	}
}

// Over what the target has already (an upgrade's, laid over a snapshot's files): a directory replaces a file or a link
// there and merges with a directory, but a file or a link where a directory is, empty or not, is refused and the
// directory kept with what is in it.
func TestExtractTarOverWhatIsThere(t *testing.T) {
	target := t.TempDir()
	for _, dir := range []string{"full", "empty", "merged", "elsewhere"} {
		if err := os.Mkdir(filepath.Join(target, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"full/kept", "merged/old", "file"} {
		if err := os.WriteFile(filepath.Join(target, name), []byte("there"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("elsewhere", filepath.Join(target, "link")); err != nil {
		t.Fatal(err)
	}
	archive := writeTar(t,
		entry{name: "file/", kind: tar.TypeDir},
		entry{name: "file/a", kind: tar.TypeReg, body: "a"},
		entry{name: "link/", kind: tar.TypeDir},
		entry{name: "link/b", kind: tar.TypeReg, body: "b"},
		entry{name: "merged/", kind: tar.TypeDir},
		entry{name: "merged/new", kind: tar.TypeReg, body: "new"},
	)
	if err := ExtractTar(archive, target, -1, -1); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"file/a", "link/b", "merged/old", "merged/new"} {
		if _, err := os.Lstat(filepath.Join(target, name)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	if names, _ := os.ReadDir(filepath.Join(target, "elsewhere")); len(names) != 0 {
		t.Fatalf("%d written through the link", len(names))
	}
	for _, e := range []entry{
		{name: "full", kind: tar.TypeSymlink, link: "file"},
		{name: "full", kind: tar.TypeReg, body: "x"},
		{name: "empty", kind: tar.TypeSymlink, link: "file"},
		{name: "empty", kind: tar.TypeReg, body: "x"},
	} {
		err := ExtractTar(writeTar(t, e), target, -1, -1)
		var refused *errArchive
		if !errors.As(err, &refused) || !strings.Contains(err.Error(), "where a directory is") {
			t.Fatalf("entry of kind %q at %s: %v", e.kind, e.name, err)
		}
		if info, err := os.Lstat(filepath.Join(target, e.name)); err != nil || !info.IsDir() {
			t.Fatalf("%s isn't the directory it was: %v", e.name, err)
		}
	}
	if got, err := os.ReadFile(filepath.Join(target, "full", "kept")); err != nil || string(got) != "there" {
		t.Fatalf("full/kept: %q %v", got, err)
	}
}

// Into a real directory (an upgrade's, into a /home/user/workspace a snapshot laid out): a link at the target, or at a
// directory above it, is refused before anything is written, and what it points at is as it was; a real directory
// merges and a missing one is made, as ExtractTar does. ExtractTar itself still goes through such a link, as an upload
// into /workspace on an upgraded microVM does.
func TestExtractTarIntoRealDir(t *testing.T) {
	archive := func(t *testing.T) string {
		return writeTar(t, entry{name: "src/", kind: tar.TypeDir}, entry{name: "src/a.txt", kind: tar.TypeReg, body: "isolate"})
	}
	outsideOf := func(t *testing.T, root string) string {
		t.Helper()
		outside := filepath.Join(root, "opt", "project")
		if err := os.MkdirAll(filepath.Join(outside, "src"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(outside, "src", "a.txt"), []byte("theirs"), 0o644); err != nil {
			t.Fatal(err)
		}
		return outside
	}
	unchanged := func(t *testing.T, outside string) {
		t.Helper()
		if got, err := os.ReadFile(filepath.Join(outside, "src", "a.txt")); err != nil || string(got) != "theirs" {
			t.Fatalf("what the link points at: %q %v", got, err)
		}
		if names, _ := os.ReadDir(filepath.Join(outside, "src")); len(names) != 1 {
			t.Fatalf("%d in what the link points at", len(names))
		}
	}
	refused := func(t *testing.T, err error, at string) {
		t.Helper()
		var refusal *errArchive
		if !errors.As(err, &refusal) || !strings.Contains(err.Error(), at+" is a symbolic link") {
			t.Fatalf("got %v, want %s refused", err, at)
		}
	}

	t.Run("a link at the target", func(t *testing.T) {
		root := t.TempDir()
		outside := outsideOf(t, root)
		target := filepath.Join(root, "home", "user", "workspace")
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, target); err != nil {
			t.Fatal(err)
		}
		refused(t, ExtractTarIntoRealDir(archive(t), target, -1, -1), target)
		unchanged(t, outside)
	})
	t.Run("a link above it", func(t *testing.T) {
		root := t.TempDir()
		outside := outsideOf(t, root)
		if err := os.MkdirAll(filepath.Join(root, "home"), 0o755); err != nil {
			t.Fatal(err)
		}
		// /home/user -> /opt, so /home/user/project would have been /opt/project, its src/a.txt written over.
		if err := os.Symlink(filepath.Dir(outside), filepath.Join(root, "home", "user")); err != nil {
			t.Fatal(err)
		}
		refused(t, ExtractTarIntoRealDir(archive(t), filepath.Join(root, "home", "user", "project"), -1, -1), filepath.Join(root, "home", "user"))
		unchanged(t, outside)
		if names, _ := os.ReadDir(filepath.Dir(outside)); len(names) != 1 {
			t.Fatalf("%d made beside what the link points at", len(names))
		}
	})
	t.Run("a real directory merges", func(t *testing.T) {
		target := filepath.Join(t.TempDir(), "workspace")
		if err := os.MkdirAll(filepath.Join(target, "src"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(target, "src", "theirs.txt"), []byte("theirs"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := ExtractTarIntoRealDir(archive(t), target, -1, -1); err != nil {
			t.Fatal(err)
		}
		for name, want := range map[string]string{"src/theirs.txt": "theirs", "src/a.txt": "isolate"} {
			if got, err := os.ReadFile(filepath.Join(target, name)); err != nil || string(got) != want {
				t.Errorf("%s: %q %v", name, got, err)
			}
		}
	})
	t.Run("a missing directory is made", func(t *testing.T) {
		target := filepath.Join(t.TempDir(), "home", "user", "workspace")
		if err := ExtractTarIntoRealDir(archive(t), target, -1, -1); err != nil {
			t.Fatal(err)
		}
		if got, err := os.ReadFile(filepath.Join(target, "src", "a.txt")); err != nil || string(got) != "isolate" {
			t.Fatalf("src/a.txt: %q %v", got, err)
		}
	})
	t.Run("ExtractTar still follows one", func(t *testing.T) {
		root := t.TempDir()
		dir := filepath.Join(root, "home", "user", "workspace")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(dir, filepath.Join(root, "workspace")); err != nil {
			t.Fatal(err)
		}
		if err := ExtractTar(archive(t), filepath.Join(root, "workspace"), -1, -1); err != nil {
			t.Fatal(err)
		}
		if got, err := os.ReadFile(filepath.Join(dir, "src", "a.txt")); err != nil || string(got) != "isolate" {
			t.Fatalf("src/a.txt: %q %v", got, err)
		}
	})
}

// The directory an extraction into a real directory holds open is refused unless it is still the one at its path
// with no link above it: a link put there, or another directory moved there, after the path was checked and before
// it was opened.
func TestHeldAtRefusesATargetChangedAsItWasOpened(t *testing.T) {
	for name, change := range map[string]func(t *testing.T, target string){
		"a link to it": func(t *testing.T, target string) {
			if err := os.Rename(target, target+".real"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target+".real", target); err != nil {
				t.Fatal(err)
			}
		},
		"another directory": func(t *testing.T, target string) {
			if err := os.Rename(target, target+".old"); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(target, 0o755); err != nil {
				t.Fatal(err)
			}
		},
		"a link above it": func(t *testing.T, target string) {
			parent := filepath.Dir(target)
			if err := os.Rename(parent, parent+".real"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(parent+".real", parent); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			target := filepath.Join(t.TempDir(), "user", "workspace")
			if err := os.MkdirAll(target, 0o755); err != nil {
				t.Fatal(err)
			}
			root, err := os.OpenRoot(target)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			if err := heldAt(root, target, -1, -1); err != nil {
				t.Fatalf("unchanged: %v", err)
			}
			change(t, target)
			var refused *errArchive
			if err := heldAt(root, target, -1, -1); !errors.As(err, &refused) {
				t.Fatalf("changed: %v", err)
			}
		})
	}
}

// A target moved aside while an extraction into a real directory is under way (another directory, or a link above it,
// put at its path between two entries) fails it once everything is written, rather than answering success for files
// the path doesn't have. The archive is a FIFO, so the move comes after the first entry and before the second.
func TestExtractTarIntoRealDirRefusesATargetMovedAsItGoes(t *testing.T) {
	for name, move := range map[string]func(t *testing.T, target string){
		"another directory": func(t *testing.T, target string) {
			if err := os.Rename(target, target+".old"); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(target, 0o755); err != nil {
				t.Fatal(err)
			}
		},
		"a link above it": func(t *testing.T, target string) {
			parent := filepath.Dir(target)
			if err := os.Rename(parent, parent+".real"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(parent+".real", parent); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			target := filepath.Join(t.TempDir(), "user", "workspace")
			if err := os.MkdirAll(target, 0o755); err != nil {
				t.Fatal(err)
			}
			fifo := filepath.Join(t.TempDir(), "a.tar")
			if err := syscall.Mkfifo(fifo, 0o600); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- ExtractTarIntoRealDir(fifo, target, -1, -1) }()
			w, err := os.OpenFile(fifo, os.O_WRONLY, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer w.Close()
			tw := tar.NewWriter(w)
			put := func(name, body string) {
				t.Helper()
				if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(body))}); err != nil {
					t.Fatal(err)
				}
				if _, err := io.WriteString(tw, body); err != nil {
					t.Fatal(err)
				}
				if err := tw.Flush(); err != nil {
					t.Fatal(err)
				}
			}
			put("a.txt", "first")
			for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(time.Millisecond) {
				if b, _ := os.ReadFile(filepath.Join(target, "a.txt")); string(b) == "first" {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("the first entry never landed")
				}
			}
			move(t, target)
			put("b.txt", "second")
			if err := tw.Close(); err != nil {
				t.Fatal(err)
			}
			w.Close()
			var refused *errArchive
			if err := <-done; !errors.As(err, &refused) {
				t.Fatalf("got %v, want the moved target refused", err)
			}
		})
	}
}

// The agent's route extracts a staged tar into its target and deletes the tar; a refused one is a 400 that says why,
// and its tar goes too.
func TestExtractArchiveRoute(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	ctx := context.Background()
	target := filepath.Join(t.TempDir(), "out")
	archive := writeTar(t, entry{name: "hi.txt", kind: tar.TypeReg, body: "hi"})
	// The route chowns to the sandbox's user, which a test that isn't root can't; ExtractTar is tested above, so here
	// only refusals and the tar's removal are checked unless running as root.
	err := client.ExtractArchive(ctx, archive, target, false)
	if os.Geteuid() == 0 {
		if err != nil {
			t.Fatal(err)
		}
		if b, _ := os.ReadFile(filepath.Join(target, "hi.txt")); string(b) != "hi" {
			t.Fatalf("extracted %q", b)
		}
	}
	if _, err := os.Stat(archive); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the tar was left: %v", err)
	}
	bad := writeTar(t, entry{name: "/etc/x", kind: tar.TypeReg, body: "x"})
	err = client.ExtractArchive(ctx, bad, target, false)
	if !IsRefused(err) || !strings.Contains(RefusalMessage(err), "absolute name") {
		t.Fatalf("a bad archive: %v", err)
	}
	if _, err := os.Stat(bad); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the refused tar was left: %v", err)
	}
	if err := client.ExtractArchive(ctx, archive, "", false); !IsRefused(err) {
		t.Fatalf("no target: %v", err)
	}
	// Asked for a real target, a link there is a 400 that says so.
	linked := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(t.TempDir(), linked); err != nil {
		t.Fatal(err)
	}
	ok := writeTar(t, entry{name: "hi.txt", kind: tar.TypeReg, body: "hi"})
	if err := client.ExtractArchive(ctx, ok, linked, true); !IsRefused(err) || !strings.Contains(RefusalMessage(err), "is a symbolic link") {
		t.Fatalf("a linked target: %v", err)
	}
	// An agent from before the route answers 404 or 405.
	older := clientFor(t, http.NewServeMux())
	if err := older.ExtractArchive(ctx, archive, target, false); !IsUnknownRoute(err) {
		t.Fatalf("an older agent: %v", err)
	}
}

// The agent's health says it extracts into a real directory (RealTarget), which the host requires before an upgrade
// into a snapshot relies on it; an agent from before it says nothing, so it reports no features.
func TestHealthReportsExtractingIntoARealDirectory(t *testing.T) {
	ctx := context.Background()
	h, err := clientFor(t, (&Server{}).Handler()).Health(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(h.Features, proto.GuestFeatureRealTarget) {
		t.Fatalf("its features %v don't say %s", h.Features, proto.GuestFeatureRealTarget)
	}
	older := http.NewServeMux()
	older.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "version": "0.1.0", "ready": []string{"ssh"}})
	})
	h, err = clientFor(t, older).Health(ctx)
	if err != nil || len(h.Features) != 0 {
		t.Fatalf("an older agent: %v %v", h.Features, err)
	}
}

// Writes at once to one path each stage into a file of their own: one aborted after another has landed leaves the
// landed file whole, and no staging file is left.
func TestOverlappingWritesKeepTheirOwnStaging(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "f.bin")
	// A long write that is still sending when the short one lands, then aborts.
	pr, pw := io.Pipe()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = client.WriteFileStream(ctx, path, pr, 0o644)
	}()
	if _, err := pw.Write(bytes.Repeat([]byte("L"), 256<<10)); err != nil {
		t.Fatal(err)
	}
	short := bytes.Repeat([]byte("S"), 1000)
	if n, err := client.WriteFileStream(ctx, path, bytes.NewReader(short), 0o644); err != nil || n != int64(len(short)) {
		t.Fatalf("the short write: %d, %v", n, err)
	}
	// The long one carries on after the short one landed, then fails.
	_, _ = pw.Write(bytes.Repeat([]byte("L"), 256<<10))
	pw.CloseWithError(errors.New("the sender went away"))
	wg.Wait()
	// The handler cleans up once it has seen the body fail; give it a moment.
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, short) {
			t.Fatalf("the landed file: %d bytes, %v", len(got), err)
		}
		names, _ := os.ReadDir(dir)
		if len(names) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d entries left beside the file", len(names))
		}
		time.Sleep(20 * time.Millisecond)
	}
}
