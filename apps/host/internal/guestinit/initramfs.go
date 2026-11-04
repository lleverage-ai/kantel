// Package guestinit is how Kantel boots any Linux image as a microVM: an initramfs holding only the static guest
// agent, which runs as the kernel's /init (kantel-guest init). It mounts the image (/dev/vda, read-only) under the
// sandbox's disk (/dev/vdb) as an overlay, puts the agent into a tmpfs at /.kantel (the image and the disk stay as
// they are), and hands over: to the image's systemd, with a unit that starts the agent, or, in an image without
// systemd (debian:trixie, alpine, busybox), to the agent's own small init, which reaps, runs the agent and powers the
// VM off when asked.
//
// The host writes the initramfs (Write) from its kantel-guest binary when injectGuestAgent is on (experimental);
// otherwise microVMs boot as before, with the image's own /usr/sbin/kantel-init and agent.
package guestinit

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// BootArgs is the kernel command line for a boot through the initramfs: as the image path's, with the initramfs's
// /init as PID 1 instead of the image's kantel-init.
const BootArgs = "console=ttyS0 reboot=k panic=1 pci=off rdinit=/init quiet loglevel=3 systemd.show_status=false"

// cpio "newc" headers (the format the kernel unpacks an initramfs from).
type entry struct {
	name  string
	mode  uint32
	data  []byte
	major uint32
	minor uint32
}

const (
	modeDir  = 0o040000
	modeFile = 0o100000
	modeChar = 0o020000
)

func writeEntry(w io.Writer, ino int, e entry) error {
	name := e.name + "\x00"
	header := fmt.Sprintf("070701%08X%08X%08X%08X%08X%08X%08X%08X%08X%08X%08X%08X%08X",
		ino, e.mode, 0, 0, 1, 0, len(e.data), 0, 0, e.major, e.minor, len(name), 0)
	if _, err := io.WriteString(w, header+name); err != nil {
		return err
	}
	if pad := (4 - (len(header)+len(name))%4) % 4; pad > 0 {
		if _, err := w.Write(make([]byte, pad)); err != nil {
			return err
		}
	}
	if _, err := w.Write(e.data); err != nil {
		return err
	}
	if pad := (4 - len(e.data)%4) % 4; pad > 0 {
		if _, err := w.Write(make([]byte, pad)); err != nil {
			return err
		}
	}
	return nil
}

// Write writes the initramfs for agent (a static kantel-guest for the guest's architecture) to w: /init, the
// directories it mounts on, and /dev/console for the kernel's first output.
func Write(w io.Writer, agent []byte) error {
	entries := []entry{
		{name: "dev", mode: modeDir | 0o755},
		{name: "dev/console", mode: modeChar | 0o600, major: 5, minor: 1},
		{name: "proc", mode: modeDir | 0o555},
		{name: "sys", mode: modeDir | 0o555},
		{name: "lower", mode: modeDir | 0o755},
		{name: "disk", mode: modeDir | 0o755},
		{name: "newroot", mode: modeDir | 0o755},
		{name: "init", mode: modeFile | 0o755, data: agent},
	}
	for i, e := range entries {
		if err := writeEntry(w, i+1, e); err != nil {
			return err
		}
	}
	return writeEntry(w, len(entries)+1, entry{name: "TRAILER!!!"})
}

// Build writes dir/initramfs-<digest>.cpio for the agent at agentPath (once: the same agent gives the same file) and
// returns its path. The name changes with the agent, so a template made with another agent is made again.
func Build(dir, agentPath string) (string, error) {
	agent, err := os.ReadFile(agentPath)
	if err != nil {
		return "", fmt.Errorf("guest agent: %w", err)
	}
	if len(agent) < 4 || string(agent[:4]) != "\x7fELF" {
		return "", fmt.Errorf("guest agent %s is not a Linux executable", agentPath)
	}
	sum := sha256.Sum256(agent)
	path := filepath.Join(dir, "initramfs-"+hex.EncodeToString(sum[:8])+".cpio")
	if _, err := os.Stat(path); err == nil {
		return path, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	tmp := path + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	if err := Write(f, agent); err != nil {
		f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	// Older initramfs files are another agent's; templates made with them are rebuilt.
	old, _ := filepath.Glob(filepath.Join(dir, "initramfs-*.cpio"))
	for _, o := range old {
		if o != path {
			_ = os.Remove(o)
		}
	}
	return path, os.Rename(tmp, path)
}
