//go:build vmtest

// A real upgrade of an isolate to a microVM on this machine: an isolate VM (workerd) and a Firecracker microVM, the
// isolate's files written by its own shell and by a file write, sandbox.upgrade, and the files, modes and links read
// back in the microVM by its own tools. It times the upgrade.
//
// It needs root, /dev/kvm, Firecracker and the guest images, so it runs only with the vmtest tag, in a privileged
// container of its own (apps/host/test/isolation.sh):
//
//	KANTEL_VMTEST_RUN=Upgrade apps/host/test/isolation.sh <images-dir> <firecracker>
//
// <images-dir> holds the kernel (vmlinux-x86_64 or vmlinux), the sandbox image (sandbox-amd64.ext4 or sandbox.ext4)
// and the isolate VM's image (isolate-amd64.ext4 or isolate.ext4), as a host's images directory does.
package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// imageIn is the first of names that dir has.
func imageIn(t *testing.T, dir string, names ...string) string {
	t.Helper()
	for _, name := range names {
		if p := filepath.Join(dir, name); fileExists(p) {
			return p
		}
	}
	t.Skipf("no %s in %s", strings.Join(names, " or "), dir)
	return ""
}

func TestUpgradeAnIsolateToAMicrovm(t *testing.T) {
	images := os.Getenv("KANTEL_VMTEST_IMAGES")
	firecracker := os.Getenv("KANTEL_VMTEST_FIRECRACKER")
	if images == "" || firecracker == "" || os.Geteuid() != 0 {
		t.Skip("needs root, KANTEL_VMTEST_IMAGES and KANTEL_VMTEST_FIRECRACKER")
	}
	cfg := Config{
		Root:         t.TempDir(),
		Kernel:       imageIn(t, images, "vmlinux-x86_64", "vmlinux"),
		SandboxImage: imageIn(t, images, "sandbox-amd64.ext4", "sandbox.ext4"),
		IsolateImage: imageIn(t, images, "isolate-amd64.ext4", "isolate.ext4"),
		Firecracker:  firecracker, Tiers: []string{"microvm", "isolate"}, Egress: "open",
	}
	cfg.Defaults()
	h, err := New(cfg, "vmtest", slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	if !h.upgradesIsolates() {
		t.Fatalf("the host runs %v and doesn't upgrade isolates", h.Tiers())
	}
	const id = "sbx_vm_upgrade"
	t.Cleanup(func() {
		_, _ = h.Call(context.Background(), proto.MethodDelete, json.RawMessage(fmt.Sprintf(`{"sandboxId":%q}`, id)), nil)
	})

	began := time.Now()
	vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: id, Tier: "isolate", Owner: "acct_vmtest", Egress: &proto.Egress{Mode: "open"}})
	t.Logf("isolate made in %v", time.Since(began))
	isolateRun := func(command string) proto.ExecResult {
		return vmCall[proto.ExecResult](t, h, proto.MethodExec, proto.ExecParams{SandboxID: id, Command: command, TimeoutMs: 30_000})
	}
	made := isolateRun("mkdir -p src/deep && echo hello > src/a.txt && printf '#!/bin/sh\\necho run\\n' > run.sh && " +
		"chmod 755 run.sh && ln -s src/a.txt link && seq 1 20000 > src/deep/numbers.txt")
	if made.ExitCode != 0 {
		t.Fatalf("the isolate's shell: %+v", made)
	}
	// A bigger file, as a file write puts it in the isolate's store.
	big := strings.Repeat("0123456789abcdef", 4<<20/16)
	vmCall[map[string]bool](t, h, proto.MethodFileWrite, proto.FileParams{SandboxID: id, Path: "/workspace/big.bin",
		Data: encodeBase64(big), Mode: 0o600})
	needs := isolateRun("git status")
	if needs.NeedsMicrovm == nil || needs.NeedsMicrovm.Command != "git" {
		t.Fatalf("git in an isolate: %+v", needs)
	}

	size := ""
	if sizes := h.Facts().Sizes; len(sizes) > 0 {
		size = sizes[0].Name
	}
	start := time.Now()
	info := vmCall[proto.SandboxInfo](t, h, proto.MethodUpgrade, proto.CreateParams{SandboxID: id, Tier: "microvm", Size: size,
		Owner: "acct_vmtest", Egress: &proto.Egress{Mode: "open"}})
	took := time.Since(start)
	t.Logf("upgrade took %v (size %s): %+v moved, timings %v", took, size, info.Moved, info.Timings)
	if info.Tier != "microvm" || info.State != proto.StateRunning || info.Moved == nil || info.Moved.Files != 7 {
		t.Fatalf("the upgrade answered %+v", info)
	}
	if _, name, err := h.tierOfNamed(id); err != nil || name != "microvm" {
		t.Fatalf("%s is now %q (%v)", id, name, err)
	}

	check := run(t, h, id, "set -e; cat /workspace/src/a.txt; readlink /workspace; readlink /home/user/workspace/link; "+
		"/workspace/run.sh; stat -c '%U %a' /home/user/workspace/run.sh; wc -l < /workspace/src/deep/numbers.txt; "+
		"stat -c '%s %a' /workspace/big.bin; git --version >/dev/null && echo has-git; "+
		"test ! -e /tmp/.kantel-upgrade.tar && echo staged-tar-gone")
	want := "hello\n/home/user/workspace\nsrc/a.txt\nrun\nuser 755\n20000\n" + fmt.Sprint(len(big)) + " 600\nhas-git\nstaged-tar-gone\n"
	if check.ExitCode != 0 || check.Stdout != want {
		t.Fatalf("in the microVM: exit %d\n%s\nstderr: %s\nwant:\n%s", check.ExitCode, check.Stdout, check.Stderr, want)
	}
	// The user's own shell finds them where the isolate had them.
	user := vmCall[proto.ExecResult](t, h, proto.MethodExec, proto.ExecParams{SandboxID: id, Command: "cd /workspace && echo more >> src/a.txt && cat src/a.txt", TimeoutMs: 30_000})
	if user.Stdout != "hello\nmore\n" {
		t.Fatalf("as its user: %+v", user)
	}
}

func encodeBase64(s string) string {
	raw, _ := json.Marshal([]byte(s))
	return strings.Trim(string(raw), `"`)
}
