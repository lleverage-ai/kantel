package microvm

import (
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// unsquashfs 4.6's `-lln -max-depth 2 -d "" image /etc`.
const unsquashfsEtc = `drwxr-xr-x 0/0                      37 2026-11-04 13:32 
drwxr-xr-x 0/0                      71 2026-11-04 13:32 /etc
drwxr-xr-x 0/0                       3 2026-11-04 13:32 /etc/a b
prw-r--r-- 0/0                       0 2026-11-04 13:32 /etc/fifo
lrwxrwxrwx 0/0                       5 2026-11-04 13:32 /etc/l -> x.txt
drwxr-xr-x 0/0                      27 2026-11-04 13:32 /etc/sub
-rwsr-xr-x 0/0                       3 2026-11-04 13:32 /etc/x.txt
`

func TestParseUnsquashfs(t *testing.T) {
	entries, found, err := parseUnsquashfs(unsquashfsEtc, "/etc")
	if err != nil || !found {
		t.Fatalf("found %v, err %v", found, err)
	}
	got := map[string]dentry{}
	for _, e := range entries {
		got[e.name] = e
	}
	want := map[string]struct {
		kind string
		mode uint32
		size int64
	}{
		"a b":   {"dir", 0o755, 3},
		"fifo":  {"other", 0o644, 0},
		"l":     {"symlink", 0o777, 5},
		"sub":   {"dir", 0o755, 27},
		"x.txt": {"file", 0o4755, 3},
	}
	if len(got) != len(want) {
		t.Fatalf("entries %v", entries)
	}
	for name, w := range want {
		e, ok := got[name]
		if !ok || kind(e.mode) != w.kind || e.mode&0o7777 != w.mode || e.size != w.size {
			t.Errorf("%s: %+v (%s), want %+v", name, e, kind(e.mode), w)
		}
	}
	if _, found, _ := parseUnsquashfs(unsquashfsEtc, "/etc/x.txt"); found {
		t.Error("a file is listed as a directory")
	}
	if _, found, _ := parseUnsquashfs(unsquashfsEtc, "/nope"); found {
		t.Error("a missing directory is found")
	}
}

// With squashfs-tools on the machine: a real squashfs image, read by its literal names (unsquashfs's wildcards off).
func TestSquashfsImageReadsLiteralNames(t *testing.T) {
	for _, tool := range []string{"mksquashfs", "unsquashfs"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip("no " + tool)
		}
	}
	src := t.TempDir()
	for name, content := range map[string]string{"app/[ab].txt": "literal", "app/a.txt": "a", "app/b.txt": "b", "app/[slug]/f": "in"} {
		full := filepath.Join(src, name)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	image := filepath.Join(t.TempDir(), "image.sqfs")
	if out, err := exec.Command("mksquashfs", src, image, "-no-progress", "-quiet").CombinedOutput(); err != nil {
		t.Fatalf("mksquashfs: %v %s", err, out)
	}
	m := &Manager{cfg: Config{Rootfs: image}}
	entries, found, err := m.imageList("/app")
	if err != nil || !found || len(entries) != 4 {
		t.Fatalf("/app: %v %v %v", entries, found, err)
	}
	if entries, found, err := m.imageList("/app/[slug]"); err != nil || !found || len(entries) != 1 || entries[0].name != "f" {
		t.Errorf("/app/[slug]: %v %v %v", entries, found, err)
	}
	if _, found, err := m.imageList("/nope"); err != nil || found {
		t.Errorf("/nope: %v %v", found, err)
	}
	got, err := m.imageRead("/app/[ab].txt", dentry{})
	if err != nil || string(got) != "literal" {
		t.Errorf("[ab].txt: %q %v", got, err)
	}
}

func TestModeOfSpecialBits(t *testing.T) {
	for s, want := range map[string]uint32{
		"drwxrwxrwt": 0o041777,
		"-rwxr-sr-x": 0o102755,
		"-rwSr--r--": 0o104644,
		"drwxr-xr-T": 0o041754,
	} {
		if got := modeOf(s); got != want {
			t.Errorf("%s: %o, want %o", s, got, want)
		}
	}
}

func TestImageFormat(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, at int, magic []byte) string {
		raw := make([]byte, 4096)
		copy(raw[at:], magic)
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, raw, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	ext := binary.LittleEndian.AppendUint16(nil, 0xEF53)
	erofs := binary.LittleEndian.AppendUint32(nil, 0xE0F5E1E2)
	for p, want := range map[string]string{
		write("a.ext4", 1080, ext):           "ext4",
		write("a.sqfs", 0, []byte("hsqs")):   "squashfs",
		write("a.erofs", 1024, erofs):        "erofs",
		write("a.raw", 0, []byte("nothing")): "",
	} {
		if got := imageFormat(p); got != want {
			t.Errorf("%s: %q, want %q", filepath.Base(p), got, want)
		}
	}
	// An image this host can't read is an error, never an empty directory.
	m := &Manager{cfg: Config{Rootfs: filepath.Join(dir, "a.erofs")}}
	_, found, err := m.imageList("/etc")
	var perr *proto.Error
	if found || !errors.As(err, &perr) || perr.Code != proto.ErrUnsupported {
		t.Errorf("erofs: found %v, err %v", found, err)
	}
}

func TestNoteGuestForgetsTheLastReport(t *testing.T) {
	dir := t.TempDir()
	m := &Manager{}
	m.noteGuest(dir, &proto.GuestCapabilities{Arch: "x86_64"})
	if _, err := os.Stat(filepath.Join(dir, guestFile)); err != nil || m.guest.Load() == nil {
		t.Fatalf("a report isn't kept: %v", err)
	}
	// A template with no report (an older agent): nothing of the one before it stays.
	m.noteGuest(dir, nil)
	if _, err := os.Stat(filepath.Join(dir, guestFile)); !os.IsNotExist(err) || m.guest.Load() != nil {
		t.Errorf("the last template's report outlives it: %v, %v", err, m.guest.Load())
	}
}
