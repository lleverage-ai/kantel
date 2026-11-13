package hostinfo

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// CPU is the host's CPU fingerprint (proto.CPUFingerprint): its vendor, family and model from /proc/cpuinfo, and the
// hash of the CPUID feature bits KVM offers a guest (KVM_GET_SUPPORTED_CPUID), which Firecracker passes on when it
// sets no CPU template. Without KVM's answer (no /dev/kvm, or a CPU without CPUID) the hash is of /proc/cpuinfo's
// flags (Features on Arm). nil when /proc/cpuinfo can't be read.
func CPU() *proto.CPUFingerprint {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return nil
	}
	defer f.Close()
	info := parseCPUInfo(f)
	if info.Vendor == "" {
		return nil
	}
	if entries, err := supportedCPUID(); err == nil && len(entries) > 0 {
		info.FeaturesHash = cpuidFeaturesHash(entries)
	} else {
		info.FeaturesHash = flagsHash(info.flags)
	}
	return &info.CPUFingerprint
}

// cpuInfo is what /proc/cpuinfo says of the CPU: its fingerprint less the hash, and its flags.
type cpuInfo struct {
	proto.CPUFingerprint
	flags []string
}

// parseCPUInfo reads the first processor's vendor, family, model and flags from /proc/cpuinfo: on x86 vendor_id,
// cpu family, model and flags; on Arm CPU implementer (as `arm:0x41`), CPU architecture, CPU part and Features. Every
// processor of a host is the same CPU.
func parseCPUInfo(r io.Reader) cpuInfo {
	var out cpuInfo
	number := func(v string) int {
		n, err := strconv.ParseInt(v, 0, 64)
		if err != nil {
			return 0
		}
		return int(n)
	}
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, 64<<10), 1<<20)
	seen := map[string]bool{}
	for s.Scan() {
		key, value, ok := strings.Cut(s.Text(), ":")
		if !ok {
			continue
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		// The first processor's block only: a key seen again is the next processor's.
		if seen[key] {
			break
		}
		seen[key] = true
		switch key {
		case "vendor_id":
			out.Vendor = value
		case "CPU implementer":
			out.Vendor = "arm:" + value
		case "cpu family", "CPU architecture":
			out.Family = number(value)
		case "model", "CPU part":
			out.Model = number(value)
		case "flags", "Features":
			out.flags = strings.Fields(value)
		}
	}
	return out
}

// cpuidEntry is one leaf (Function) and subleaf (Index) of CPUID, as KVM_GET_SUPPORTED_CPUID answers it.
type cpuidEntry struct {
	Function, Index    uint32
	EAX, EBX, ECX, EDX uint32
}

// cpuidFeatureWord is one register of one CPUID leaf that holds feature bits: the words Linux's KVM keeps its guest
// capabilities in (arch/x86/kvm/reverse_cpuid.h), and the XSAVE state the guest may use (leaf 0xD: the user and
// supervisor components supported, the largest area they take, and, in subleaves 2 on, each component's size, offset
// and alignment, hashed beside these by cpuidFeaturesHash), which a snapshot's saved registers depend on. Everything
// else in CPUID (topology, cache sizes, the APIC ID of the CPU that asked, the brand string, and leaf 0xD's EBX, the
// size for the components enabled now) varies between machines of one model, or between runs on one, without changing
// what a guest may use.
type cpuidFeatureWord struct {
	function, index uint32
	register        byte // 'a', 'b', 'c' or 'd'
}

var cpuidFeatureWords = []cpuidFeatureWord{
	{0x1, 0, 'c'}, {0x1, 0, 'd'},
	{0x6, 0, 'a'},
	{0x7, 0, 'b'}, {0x7, 0, 'c'}, {0x7, 0, 'd'}, {0x7, 1, 'a'}, {0x7, 1, 'd'}, {0x7, 2, 'd'},
	{0xd, 0, 'a'}, {0xd, 0, 'c'}, {0xd, 0, 'd'}, {0xd, 1, 'a'}, {0xd, 1, 'c'}, {0xd, 1, 'd'},
	{0x12, 0, 'a'},
	{0x14, 0, 'c'},
	{0x19, 0, 'b'},
	{0x24, 0, 'b'},
	{0x80000001, 0, 'c'}, {0x80000001, 0, 'd'},
	{0x80000007, 0, 'b'}, {0x80000007, 0, 'd'},
	{0x80000008, 0, 'b'},
	{0x8000000a, 0, 'd'},
	{0x8000001f, 0, 'a'},
	{0x80000021, 0, 'a'},
	{0x80000022, 0, 'a'},
}

// cpuidFeaturesHash hashes the feature words (cpuidFeatureWords) of a CPUID answer, then each XSAVE component's
// subleaf of leaf 0xD (2 on) by subleaf: `sha256:` and the first 16 hex digits of the SHA-256 of one
// `leaf.subleaf.register=value` line per word present. A leaf the CPU lacks is left out, so two answers differing only
// in it differ.
func cpuidFeaturesHash(entries []cpuidEntry) string {
	type key struct{ function, index uint32 }
	byLeaf := make(map[key]cpuidEntry, len(entries))
	for _, e := range entries {
		byLeaf[key{e.Function, e.Index}] = e
	}
	h := sha256.New()
	fmt.Fprintf(h, "cpuid-features v1\n")
	for _, w := range cpuidFeatureWords {
		e, ok := byLeaf[key{w.function, w.index}]
		if !ok {
			continue
		}
		var v uint32
		switch w.register {
		case 'a':
			v = e.EAX
		case 'b':
			v = e.EBX
		case 'c':
			v = e.ECX
		case 'd':
			v = e.EDX
		}
		fmt.Fprintf(h, "%08x.%d.e%cx=%08x\n", w.function, w.index, w.register, v)
	}
	// Each XSAVE component's size (EAX), offset in the standard layout (EBX) and whether it is supervisor state or
	// aligned (ECX).
	var components []cpuidEntry
	for _, e := range byLeaf {
		if e.Function == 0xd && e.Index >= 2 {
			components = append(components, e)
		}
	}
	sort.Slice(components, func(i, j int) bool { return components[i].Index < components[j].Index })
	for _, e := range components {
		fmt.Fprintf(h, "0000000d.%d.eax=%08x ebx=%08x ecx=%08x\n", e.Index, e.EAX, e.EBX, e.ECX)
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil))[:16]
}

// flagsHash hashes a CPU's flags as /proc/cpuinfo lists them, sorted: the fallback where KVM can't say.
func flagsHash(flags []string) string {
	sorted := append([]string{}, flags...)
	sort.Strings(sorted)
	h := sha256.New()
	fmt.Fprintf(h, "cpuinfo-flags v1\n%s\n", strings.Join(sorted, " "))
	return "sha256:" + hex.EncodeToString(h.Sum(nil))[:16]
}

// kvmGetSupportedCPUID is KVM_GET_SUPPORTED_CPUID: _IOWR(KVMIO, 0x05, struct kvm_cpuid2), on /dev/kvm itself.
const kvmGetSupportedCPUID = 0xc008ae05

// kvmCPUIDEntryWords is struct kvm_cpuid_entry2 in 32-bit words: function, index, flags, eax, ebx, ecx, edx, padding[3].
const kvmCPUIDEntryWords = 10

var errNoCPUID = errors.New("CPUID is x86's")

// supportedCPUID asks KVM which CPUID leaves and bits it offers a guest.
func supportedCPUID() ([]cpuidEntry, error) {
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "386" {
		return nil, errNoCPUID
	}
	f, err := os.OpenFile("/dev/kvm", os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	// KVM answers E2BIG while the buffer is too small for every entry.
	for n := 128; n <= 4096; n *= 2 {
		buf := make([]uint32, 2+n*kvmCPUIDEntryWords)
		buf[0] = uint32(n)
		_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), kvmGetSupportedCPUID, uintptr(unsafe.Pointer(&buf[0])))
		if errno == syscall.E2BIG {
			continue
		}
		if errno != 0 {
			return nil, errno
		}
		return decodeCPUID(buf), nil
	}
	return nil, syscall.E2BIG
}

// decodeCPUID reads a struct kvm_cpuid2 as words: nent, padding, then nent entries.
func decodeCPUID(buf []uint32) []cpuidEntry {
	n := int(buf[0])
	out := make([]cpuidEntry, 0, n)
	for i := 0; i < n && 2+(i+1)*kvmCPUIDEntryWords <= len(buf); i++ {
		w := buf[2+i*kvmCPUIDEntryWords:]
		out = append(out, cpuidEntry{Function: w[0], Index: w[1], EAX: w[3], EBX: w[4], ECX: w[5], EDX: w[6]})
	}
	return out
}
