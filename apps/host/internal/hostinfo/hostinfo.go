// Package hostinfo finds out what a host can run: KVM, nested virtualisation, CPUs, memory, disk.
package hostinfo

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Check is one prerequisite, as `kantel-host doctor` shows it.
type Check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
	// Needed for the microVM tier (the isolate tier runs without them, natively).
	MicroVM bool `json:"microvm"`
}

// KVM reports whether /dev/kvm opens read-write.
func KVM() (bool, string) {
	f, err := os.OpenFile("/dev/kvm", os.O_RDWR, 0)
	if err != nil {
		if os.IsNotExist(err) {
			return false, "/dev/kvm is missing: enable virtualisation (VT-x/AMD-V) in the firmware, or on a cloud VM pick a type with nested virtualisation, then load kvm_intel or kvm_amd"
		}
		return false, fmt.Sprintf("/dev/kvm: %v (run as root, or add the user to the kvm group)", err)
	}
	f.Close()
	return true, "/dev/kvm opens read-write"
}

// Nested reports whether KVM guests can themselves use KVM (sandboxes get /dev/kvm).
func Nested() (bool, string) {
	for _, mod := range []string{"kvm_intel", "kvm_amd"} {
		raw, err := os.ReadFile("/sys/module/" + mod + "/parameters/nested")
		if err != nil {
			continue
		}
		v := strings.TrimSpace(string(raw))
		if v == "Y" || v == "1" {
			return true, mod + " nested=" + v
		}
		return false, mod + " nested=" + v + " (sandboxes won't get /dev/kvm; set `options " + mod + " nested=1` in /etc/modprobe.d and reload the module)"
	}
	return false, "no kvm_intel or kvm_amd module loaded"
}

// InVM reports whether the host itself is a virtual machine (the CPU's hypervisor flag).
func InVM() bool {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return false
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := s.Text()
		if strings.HasPrefix(line, "flags") {
			return strings.Contains(line, " hypervisor")
		}
	}
	return false
}

// MemoryMiB is the machine's total memory.
func MemoryMiB() int64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) >= 2 && fields[0] == "MemTotal:" {
			kb, _ := strconv.ParseInt(fields[1], 10, 64)
			return kb / 1024
		}
	}
	return 0
}

// AvailableMemoryMiB is what the kernel says is available now.
func AvailableMemoryMiB() int64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) >= 2 && fields[0] == "MemAvailable:" {
			kb, _ := strconv.ParseInt(fields[1], 10, 64)
			return kb / 1024
		}
	}
	return 0
}

// FreeDiskGiB is the free space on the filesystem holding path.
func FreeDiskGiB(path string) int64 {
	var st syscall.Statfs_t
	if syscall.Statfs(path, &st) != nil {
		return 0
	}
	return int64(st.Bavail) * int64(st.Bsize) >> 30
}

// Load1 is the one-minute load average.
func Load1() float64 {
	raw, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(raw))
	if len(fields) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(fields[0], 64)
	return v
}

// Kernel is the running kernel's release.
func Kernel() string {
	var u syscall.Utsname
	if syscall.Uname(&u) != nil {
		return ""
	}
	var b strings.Builder
	for _, c := range u.Release {
		if c == 0 {
			break
		}
		b.WriteByte(byte(c))
	}
	return b.String()
}

// Arch is the host's architecture as Kantel names it.
func Arch() string {
	if runtime.GOARCH == "arm64" {
		return "aarch64"
	}
	return "x86_64"
}

// Checks runs every prerequisite check.
func Checks(root string) []Check {
	var out []Check
	ok, detail := KVM()
	out = append(out, Check{Name: "kvm", OK: ok, Detail: detail, MicroVM: true})
	nested, ndetail := Nested()
	out = append(out, Check{Name: "nested virtualisation", OK: nested, Detail: ndetail})
	if InVM() {
		out = append(out, Check{Name: "host is a VM", OK: ok, Detail: "this host is itself a virtual machine: microVMs need its hypervisor to expose nested virtualisation"})
	}
	out = append(out, Check{Name: "root", OK: os.Geteuid() == 0, Detail: "kantel-host runs as root (TAP devices, iptables, /dev/kvm)", MicroVM: true})
	for _, tool := range []string{"ip", "iptables", "mkfs.ext4", "cp"} {
		_, err := lookPath(tool)
		out = append(out, Check{Name: tool, OK: err == nil, Detail: pathDetail(tool, err), MicroVM: true})
	}
	docker, ddetail := Docker()
	out = append(out, Check{Name: "docker", OK: docker, Detail: ddetail})
	if _, err := os.Stat("/dev/net/tun"); err != nil {
		out = append(out, Check{Name: "tun", OK: false, Detail: "/dev/net/tun is missing (modprobe tun)", MicroVM: true})
	} else {
		out = append(out, Check{Name: "tun", OK: true, Detail: "/dev/net/tun", MicroVM: true})
	}
	free := FreeDiskGiB(root)
	out = append(out, Check{Name: "disk", OK: free >= 20, Detail: fmt.Sprintf("%d GiB free at %s (20 GiB or more recommended)", free, root)})
	mem := MemoryMiB()
	out = append(out, Check{Name: "memory", OK: mem >= 4096, Detail: fmt.Sprintf("%d MiB (4 GiB or more recommended)", mem)})
	if runtime.GOOS != "linux" {
		out = append(out, Check{Name: "os", OK: false, Detail: runtime.GOOS + ": only Linux hosts run sandboxes for now", MicroVM: true})
	}
	return out
}

// Docker reports whether the host's Docker answers: templates' images are built with it. Only template builds need
// it; sandboxes, and templates already built, run without it.
func Docker() (bool, string) {
	if _, err := exec.LookPath("docker"); err != nil {
		return false, "docker not found on PATH: install Docker Engine and start it for this host to build templates (sandboxes run without it)"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "version", "--format", "{{.Server.Version}}").CombinedOutput()
	if err != nil {
		return false, fmt.Sprintf("the Docker daemon doesn't answer (%s): start it for this host to build templates (sandboxes run without it)", strings.TrimSpace(lastLine(string(out))))
	}
	return true, "Docker " + strings.TrimSpace(string(out)) + " builds templates' images"
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[len(lines)-1]
}

func pathDetail(tool string, err error) string {
	if err != nil {
		return tool + " not found on PATH"
	}
	return tool
}

func lookPath(name string) (string, error) {
	for _, dir := range strings.Split(os.Getenv("PATH")+":/usr/sbin:/sbin", ":") {
		if dir == "" {
			continue
		}
		p := dir + "/" + name
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", os.ErrNotExist
}
