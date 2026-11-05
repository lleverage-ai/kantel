package guestinit

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

type parsed struct {
	mode, major, minor uint64
	data               []byte
}

// readNewc parses a newc cpio archive as the kernel does, checking each header's magic and alignment.
func readNewc(t *testing.T, raw []byte) map[string]parsed {
	t.Helper()
	out := map[string]parsed{}
	align := func(n int) int { return (n + 3) &^ 3 }
	for off := 0; ; {
		if off+110 > len(raw) || string(raw[off:off+6]) != "070701" {
			t.Fatalf("no newc header at %d", off)
		}
		field := func(i int) uint64 {
			v, err := strconv.ParseUint(string(raw[off+6+8*i:off+14+8*i]), 16, 32)
			if err != nil {
				t.Fatalf("header field %d at %d: %v", i, off, err)
			}
			return v
		}
		mode, size, major, minor, namesize := field(1), int(field(6)), field(9), field(10), int(field(11))
		name := string(raw[off+110 : off+110+namesize-1])
		dataAt := align(off + 110 + namesize)
		data := raw[dataAt : dataAt+size]
		off = align(dataAt + size)
		if name == "TRAILER!!!" {
			if off != len(raw) {
				t.Errorf("%d bytes after the trailer", len(raw)-off)
			}
			return out
		}
		out[name] = parsed{mode: mode, major: major, minor: minor, data: data}
	}
}

func TestWrite(t *testing.T) {
	// An odd length, so the data's padding shows.
	agent := []byte("\x7fELF the agent!")
	var buf bytes.Buffer
	if err := Write(&buf, agent); err != nil {
		t.Fatal(err)
	}
	files := readNewc(t, buf.Bytes())
	if init := files["init"]; !bytes.Equal(init.data, agent) || init.mode != modeFile|0o755 {
		t.Errorf("init: mode %o, %q", init.mode, init.data)
	}
	if c := files["dev/console"]; c.mode != modeChar|0o600 || c.major != 5 || c.minor != 1 {
		t.Errorf("dev/console: %+v", c)
	}
	for _, dir := range []string{"dev", "proc", "sys", "lower", "disk", "newroot"} {
		if files[dir].mode&modeDir == 0 {
			t.Errorf("%s isn't a directory", dir)
		}
	}
}

func TestBuild(t *testing.T) {
	dir := t.TempDir()
	agent := filepath.Join(dir, "kantel-guest")
	if err := os.WriteFile(agent, []byte("\x7fELF one"), 0o755); err != nil {
		t.Fatal(err)
	}
	first, err := Build(filepath.Join(dir, "out"), agent)
	if err != nil {
		t.Fatal(err)
	}
	again, _ := Build(filepath.Join(dir, "out"), agent)
	if again != first {
		t.Errorf("the same agent made %s, then %s", first, again)
	}
	if err := os.WriteFile(agent, []byte("\x7fELF two"), 0o755); err != nil {
		t.Fatal(err)
	}
	if other, _ := Build(filepath.Join(dir, "out"), agent); other == first {
		t.Error("another agent kept the same initramfs name, so templates wouldn't be made again")
	}
	if err := os.WriteFile(agent, []byte("#!/bin/sh"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Build(filepath.Join(dir, "out"), agent); err == nil {
		t.Error("a script was taken for the agent")
	}
}
