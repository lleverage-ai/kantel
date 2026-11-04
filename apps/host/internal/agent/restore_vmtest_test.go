//go:build vmtest

// Real-VM restore tests: sandboxes restored from one template snapshot must each come up as a machine of their own,
// and work. Every clone starts from the same memory, so anything the template held (the kernel's random state, the
// hostname, machine-id, MAC address, clock) is the same in all of them until something changes it. They cover both
// template modes: one template per size (the default) and the shared templates (MicroVMConfig.SharedTemplate).
//
//	KANTEL_VMTEST_IMAGES=/images KANTEL_VMTEST_FIRECRACKER=/opt/kantel/firecracker \
//	  go test -tags vmtest -run Restore -v ./internal/agent/
//
// Like the isolation tests, run them in a privileged container (apps/host/test/isolation.sh shows how).
package agent

import (
	"fmt"
	"log/slog"
	"math"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// probeScript prints what makes a sandbox itself, one key=value a line.
const probeScript = `
echo hostname=$(hostname)
echo machine_id=$(cat /etc/machine-id)
echo mac=$(cat /sys/class/net/eth0/address)
echo ip=$(ip -4 -o addr show dev eth0 | awk '{print $4}')
echo random=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
echo vmgenid_bound=$(ls /sys/bus/acpi/drivers/vmgenid 2>/dev/null | grep -c :)
echo vmfork_reseeds=$(dmesg | grep -c 'crng reseeded due to virtual machine fork')
echo clock_ms=$(date +%s%3N)
up=$(cut -d' ' -f1 /proc/uptime); echo kantel-probe-$$ > /dev/kmsg
echo sched_skew_ms=$(dmesg | grep kantel-probe-$$ | tail -1 | sed 's/^\[ *\([0-9.]*\)\].*/\1/' | awk -v up=$up '{printf "%d", ($1-up)*1000}')
echo vcpus=$(nproc)
echo mem_kib=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
echo disk_gib=$(df -BG --output=size /disk | tail -1 | tr -dc 0-9)
echo kvm=$(python3 -c "
import fcntl, os
fd = os.open('/dev/kvm', os.O_RDWR)
assert fcntl.ioctl(fd, 0xAE00) == 12  # KVM_GET_API_VERSION
vm = fcntl.ioctl(fd, 0xAE01, 0)         # KVM_CREATE_VM
print('ok' if vm > 0 else 'no')
" 2>&1 | tail -1)
`

func probeSandbox(t *testing.T, h *Host, id string) map[string]string {
	t.Helper()
	res := run(t, h, id, probeScript)
	if res.ExitCode != 0 {
		t.Fatalf("%s: probe exited %d: %s", id, res.ExitCode, res.Stderr)
	}
	out := map[string]string{}
	for _, line := range strings.Split(res.Stdout, "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			out[k] = v
		}
	}
	return out
}

func TestRestoreIdentity(t *testing.T) {
	images := os.Getenv("KANTEL_VMTEST_IMAGES")
	firecracker := os.Getenv("KANTEL_VMTEST_FIRECRACKER")
	if images == "" || firecracker == "" || os.Geteuid() != 0 {
		t.Skip("needs root, KANTEL_VMTEST_IMAGES and KANTEL_VMTEST_FIRECRACKER")
	}
	// A create: a named size or a custom shape, restored from a template made first (wait) or not.
	type create struct {
		size      string
		vcpus     int
		memoryMiB int
		diskGiB   int
		wait      bool
	}
	named := func(size string) create { return create{size: size, wait: true} }
	for _, mode := range []struct {
		name    string
		shared  bool
		creates []create
	}{
		{"per-size", false, []create{named("default"), named("default"), named("default")}},
		{"shared", true, []create{
			named("default"), named("default"), named("small"), named("large"),
			// Custom shapes off the named sizes: one of a count with a template (4 vCPUs), one of a new count (3)
			// that cold-boots while its template is made, then one restored from it.
			{vcpus: 4, memoryMiB: 6144, diskGiB: 50, wait: true},
			{vcpus: 3, memoryMiB: 2048, diskGiB: 20},
			{vcpus: 3, memoryMiB: 3584, diskGiB: 20, wait: true},
		}},
	} {
		t.Run(mode.name, func(t *testing.T) {
			cfg := Config{
				Root: t.TempDir(), Kernel: filepath.Join(images, "vmlinux-x86_64"), SandboxImage: filepath.Join(images, "sandbox-amd64.ext4"),
				Firecracker: firecracker, Tiers: []string{"microvm"}, Egress: "open", SpoolMaxMiB: -1,
				MicroVM: MicroVMConfig{SharedTemplate: &mode.shared},
			}
			cfg.Defaults()
			h, err := New(cfg, "vmtest", slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(h.Close)
			sizes := map[string]proto.Size{}
			for _, s := range h.Facts().Sizes {
				sizes[s.Name] = s
			}
			seen := map[string]map[string]string{}
			first := ""
			for i, c := range mode.creates {
				id := fmt.Sprintf("sbx_restore_%s_%d", strings.ReplaceAll(mode.name, "-", ""), i)
				params := proto.CreateParams{SandboxID: id, Tier: "microvm", Size: c.size, VCPUs: c.vcpus, MemoryMiB: c.memoryMiB, DiskGiB: c.diskGiB}
				if c.wait {
					if err := h.WaitTemplate(t.Context(), "microvm", params); err != nil {
						t.Fatal(err)
					}
				}
				info := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, params)
				t.Cleanup(func() { _ = call(t, h, proto.MethodDelete, proto.SandboxRef{SandboxID: id}) })
				if first == "" {
					first = id
				}
				if wantSource := map[bool]string{true: "snapshot", false: "boot"}[c.wait]; info.Source != wantSource {
					t.Errorf("%s: made by %s, want %s", id, info.Source, wantSource)
				}
				hostClock := time.Now().UnixMilli()
				p := probeSandbox(t, h, id)
				size := c.size
				if size == "" {
					size = fmt.Sprintf("custom-%dc-%dm-%dg", c.vcpus, c.memoryMiB, c.diskGiB)
					sizes[size] = proto.Size{Name: size, VCPUs: c.vcpus, MemoryMiB: c.memoryMiB, DiskGiB: c.diskGiB}
				}
				t.Logf("%s (%s, %s, %.0f ms): %v", id, size, info.Source, info.Timings["total"], p)

				// A machine of its own.
				for _, key := range []string{"hostname", "machine_id", "mac", "ip", "random"} {
					if p[key] == "" {
						t.Errorf("%s: no %s", id, key)
					}
					if seen[key] == nil {
						seen[key] = map[string]string{}
					}
					if other, ok := seen[key][p[key]]; ok {
						t.Errorf("%s has the same %s as %s: %s", id, key, other, p[key])
					}
					seen[key][p[key]] = id
				}
				if !strings.HasPrefix(p["ip"], info.Address+"/") {
					t.Errorf("%s: eth0 is %s, the host gave it %s", id, p["ip"], info.Address)
				}
				// The kernel's random state: every clone resumes with the template's, so the kernel must reseed itself when
				// restored (VMGenID), not only take the entropy the host's agent hands it.
				if p["vmgenid_bound"] == "0" {
					t.Errorf("%s: no vmgenid device bound: the kernel can't tell it was restored", id)
				}
				if info.Source != "boot" && p["vmfork_reseeds"] == "0" {
					t.Errorf("%s: the kernel didn't reseed its RNG on restore (no \"crng reseeded due to virtual machine fork\")", id)
				}
				if clock, _ := strconv.ParseInt(p["clock_ms"], 10, 64); math.Abs(float64(clock-hostClock)) > 5000 {
					t.Errorf("%s: guest clock %d is %d ms off the host's", id, clock, clock-hostClock)
				}
				// The scheduler's clock (the kernel log's) didn't jump at the restore: it stays with the guest's uptime. Moved
				// on by the time since the template was made, it charged that time to whatever the template's vCPU was running,
				// and a 1-vCPU restore's agent answered seconds late (TASK-5137).
				if skew, err := strconv.Atoi(p["sched_skew_ms"]); err != nil || math.Abs(float64(skew)) > 2000 {
					t.Errorf("%s: the kernel log's clock is %q ms off the guest's uptime", id, p["sched_skew_ms"])
				}
				// Nested virtualisation, when this machine has it.
				if h.Facts().Nested && p["kvm"] != "ok" {
					t.Errorf("%s: /dev/kvm doesn't work: %s", id, p["kvm"])
				}
				// Its size.
				want := sizes[size]
				if got, _ := strconv.Atoi(p["vcpus"]); got != want.VCPUs {
					t.Errorf("%s: %d vCPUs, want %d", id, got, want.VCPUs)
				}
				// MemTotal is what's left after the kernel's own reservations: within 10% below the size.
				if got, _ := strconv.Atoi(p["mem_kib"]); float64(got) < float64(want.MemoryMiB)*1024*0.9 || got > want.MemoryMiB*1024 {
					t.Errorf("%s: MemTotal %d KiB for a %d MiB size", id, got, want.MemoryMiB)
				}
				// The disk grows just after the create answers (shared templates): give it a few seconds.
				deadline := time.Now().Add(15 * time.Second)
				for {
					got, _ := strconv.Atoi(strings.TrimSpace(run(t, h, id, "df -BG --output=size /disk | tail -1 | tr -dc 0-9").Stdout))
					if got >= want.DiskGiB-1 && got <= want.DiskGiB {
						break
					}
					if time.Now().After(deadline) {
						t.Errorf("%s: a %d GiB disk, want %d", id, got, want.DiskGiB)
						break
					}
					time.Sleep(200 * time.Millisecond)
				}
				// The network: out through the host's egress proxy.
				gw := netip.MustParseAddr(info.Address).Prev()
				if res := run(t, h, id, fmt.Sprintf("curl -sS -m 10 -o /dev/null -w '%%{http_code}' --noproxy '' -x http://%s:3129 https://example.com/", gw)); strings.TrimSpace(res.Stdout) != "200" {
					t.Errorf("%s: example.com through the proxy: %q %s", id, res.Stdout, res.Stderr)
				}
				// A cold boot answers once its agent does, as on main, before Docker has started: wait for it here.
				if info.Source == "boot" {
					booted := time.Now()
					res := run(t, h, id, "for i in $(seq 120); do docker info >/dev/null 2>&1 && exit 0; sleep 0.5; done; exit 1")
					t.Logf("%s: Docker up %.1f s after a cold boot answered (exit %d)", id, time.Since(booted).Seconds(), res.ExitCode)
				}
				// Docker runs a container (an image made in the sandbox: no registry needed).
				docker := `set -e
tar -chf /tmp/mini.tar /usr/bin/bash /lib/x86_64-linux-gnu/libc.so.6 /lib/x86_64-linux-gnu/libtinfo.so.6 /lib64/ld-linux-x86-64.so.2 2>/dev/null
docker import /tmp/mini.tar kantel-mini >/dev/null
docker run --rm --network none kantel-mini /usr/bin/bash -c 'echo container-ok'`
				if res := run(t, h, id, docker); !strings.Contains(res.Stdout, "container-ok") {
					t.Errorf("%s: docker run: exit %d: %s %s", id, res.ExitCode, res.Stdout, res.Stderr)
				}
			}
			// A stop keeps memory and a resume restores it, plugged memory and grown disk included.
			keep := true
			before := probeSandbox(t, h, first)
			if err := call(t, h, proto.MethodStop, proto.StopParams{SandboxID: first, SnapshotID: first + "_stop", Memory: &keep}); err != nil {
				t.Fatal(err)
			}
			vmCall[proto.SandboxInfo](t, h, proto.MethodResume, proto.ResumeParams{SandboxID: first})
			after := probeSandbox(t, h, first)
			for _, key := range []string{"hostname", "machine_id", "mac", "vcpus", "mem_kib", "disk_gib"} {
				if before[key] != after[key] {
					t.Errorf("%s: %s was %s before a stop and resume, %s after", first, key, before[key], after[key])
				}
			}
		})
	}
}
