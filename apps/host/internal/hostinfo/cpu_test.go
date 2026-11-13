package hostinfo

import (
	"os"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// ryzen7950X3D is the start of /proc/cpuinfo on a Hetzner AX102 (two processors of its 32 shown).
const ryzen7950X3D = `processor	: 0
vendor_id	: AuthenticAMD
cpu family	: 25
model		: 97
model name	: AMD Ryzen 9 7950X3D 16-Core Processor
stepping	: 2
microcode	: 0xa601206
cpu MHz		: 4200.000
flags		: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx mmxext fxsr_opt pdpe1gb rdtscp lm constant_tsc rep_good amd_lbr_v2 nopl nonstop_tsc cpuid extd_apicid aperfmperf rapl pni pclmulqdq monitor ssse3 fma cx16 sse4_1 sse4_2 movbe popcnt aes xsave avx f16c rdrand lahf_lm svm avx2 avx512f avx512dq
bugs		: sysret_ss_attrs spectre_v1 spectre_v2 spec_store_bypass srso

processor	: 1
vendor_id	: AuthenticAMD
cpu family	: 25
model		: 97
model name	: AMD Ryzen 9 7950X3D 16-Core Processor
stepping	: 2
`

const armNeoverse = `processor	: 0
BogoMIPS	: 50.00
Features	: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm lrcpc dcpop asimddp ssbs
CPU implementer	: 0x41
CPU architecture: 8
CPU variant	: 0x3
CPU part	: 0xd0c
CPU revision	: 1
`

func TestParseCPUInfo(t *testing.T) {
	got := parseCPUInfo(strings.NewReader(ryzen7950X3D))
	want := proto.CPUFingerprint{Vendor: "AuthenticAMD", Family: 25, Model: 97}
	if got.CPUFingerprint != want {
		t.Fatalf("parseCPUInfo(7950X3D) = %+v, want %+v", got.CPUFingerprint, want)
	}
	if len(got.flags) == 0 || got.flags[0] != "fpu" {
		t.Fatalf("flags = %v", got.flags)
	}
	arm := parseCPUInfo(strings.NewReader(armNeoverse))
	if want := (proto.CPUFingerprint{Vendor: "arm:0x41", Family: 8, Model: 0xd0c}); arm.CPUFingerprint != want {
		t.Fatalf("parseCPUInfo(Neoverse) = %+v, want %+v", arm.CPUFingerprint, want)
	}
	if empty := parseCPUInfo(strings.NewReader("")); empty.Vendor != "" {
		t.Fatalf("parseCPUInfo(\"\") = %+v", empty)
	}
}

// ax102CPUID is part of KVM_GET_SUPPORTED_CPUID's answer on a 7950X3D as one machine (apic) would see it: leaf 1's
// EBX carries the APIC ID of the CPU the ioctl ran on, and leaves 0xB and 0x8000001E its topology.
func ax102CPUID(apic uint32) []cpuidEntry {
	return []cpuidEntry{
		{Function: 0x0, EAX: 0x10, EBX: 0x68747541, ECX: 0x444d4163, EDX: 0x69746e65},
		{Function: 0x1, EAX: 0x00a60f12, EBX: apic<<24 | 0x00200800, ECX: 0xf6d8320b, EDX: 0x178bfbff},
		{Function: 0x7, EBX: 0xf1bf97a9, ECX: 0x00405fce, EDX: 0x10000010},
		{Function: 0x7, Index: 1, EAX: 0x00000030},
		{Function: 0xb, EBX: 2, ECX: 0x100 | apic, EDX: apic},
		{Function: 0xd, EAX: 0x000002e7, EBX: 0x340 + apic%2*0x648, ECX: 0x988},
		{Function: 0xd, Index: 1, EAX: 0x0000000f, ECX: 0x00001800},
		{Function: 0xd, Index: 2, EAX: 0x100, EBX: 0x240},
		{Function: 0xd, Index: 5, EAX: 0x40, EBX: 0x340},
		{Function: 0x80000001, EAX: 0x00a60f12, ECX: 0x75c237ff, EDX: 0x2fd3fbff},
		{Function: 0x80000002, EAX: 0x20444d41, EBX: 0x657a7952, ECX: 0x2039206e, EDX: 0x30353937},
		{Function: 0x80000008, EAX: 0x00003030, EBX: 0x791ef257, ECX: 0x0000501f},
		{Function: 0x8000001e, EAX: apic, EBX: 0x100 | apic/2},
		{Function: 0x80000021, EAX: 0x00062fcf},
	}
}

func TestCPUIDFeaturesHash(t *testing.T) {
	one := cpuidFeaturesHash(ax102CPUID(0))
	if !strings.HasPrefix(one, "sha256:") || len(one) != len("sha256:")+16 {
		t.Fatalf("hash %q isn't sha256: and 16 hex digits", one)
	}
	// Two AX102s, or one asked on another CPU: the APIC ID and topology differ, the features don't.
	if other := cpuidFeaturesHash(ax102CPUID(17)); other != one {
		t.Fatalf("an AX102 asked on another CPU hashes %s, want %s", other, one)
	}
	reversed := ax102CPUID(3)
	for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
		reversed[i], reversed[j] = reversed[j], reversed[i]
	}
	if got := cpuidFeaturesHash(reversed); got != one {
		t.Fatalf("the same leaves in another order hash %s, want %s", got, one)
	}
	// Without AVX-512F (leaf 7 EBX bit 16), or without leaf 0x80000021: another CPU to a guest.
	noAVX512 := ax102CPUID(0)
	noAVX512[2].EBX &^= 1 << 16
	if got := cpuidFeaturesHash(noAVX512); got == one {
		t.Fatal("a CPU without AVX-512F hashes the same")
	}
	noLeaf := ax102CPUID(0)[:13]
	if got := cpuidFeaturesHash(noLeaf); got == one {
		t.Fatal("a CPU without leaf 0x80000021 hashes the same")
	}
	// Fewer XSAVE state components (leaf 0xD EAX): a snapshot's saved registers wouldn't fit.
	lessXSAVE := ax102CPUID(0)
	lessXSAVE[5].EAX = 0x7
	if got := cpuidFeaturesHash(lessXSAVE); got == one {
		t.Fatal("a CPU with fewer XSAVE components hashes the same")
	}
	// Other supervisor state (leaf 0xD subleaf 1 ECX), or a component laid out elsewhere: another CPU too.
	supervisor := ax102CPUID(0)
	supervisor[6].ECX = 0x00000800
	if got := cpuidFeaturesHash(supervisor); got == one {
		t.Fatal("a CPU with other supervisor XSAVE state hashes the same")
	}
	moved := ax102CPUID(0)
	moved[8].EBX = 0x380
	if got := cpuidFeaturesHash(moved); got == one {
		t.Fatal("an XSAVE component at another offset hashes the same")
	}
	fewer := append(ax102CPUID(0)[:8:8], ax102CPUID(0)[9:]...)
	if got := cpuidFeaturesHash(fewer); got == one {
		t.Fatal("a CPU without an XSAVE component's subleaf hashes the same")
	}
}

func TestDecodeCPUID(t *testing.T) {
	buf := make([]uint32, 2+3*kvmCPUIDEntryWords)
	buf[0] = 2
	copy(buf[2:], []uint32{0x7, 1, 1, 0xa, 0xb, 0xc, 0xd})
	copy(buf[2+kvmCPUIDEntryWords:], []uint32{0x80000001, 0, 0, 1, 2, 3, 4})
	got := decodeCPUID(buf)
	want := []cpuidEntry{
		{Function: 0x7, Index: 1, EAX: 0xa, EBX: 0xb, ECX: 0xc, EDX: 0xd},
		{Function: 0x80000001, EAX: 1, EBX: 2, ECX: 3, EDX: 4},
	}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("decodeCPUID = %+v, want %+v", got, want)
	}
}

func TestFlagsHash(t *testing.T) {
	if flagsHash([]string{"sse", "avx"}) != flagsHash([]string{"avx", "sse"}) {
		t.Fatal("flags in another order hash differently")
	}
	if flagsHash([]string{"sse", "avx"}) == flagsHash([]string{"sse"}) {
		t.Fatal("fewer flags hash the same")
	}
}

func TestCPUFingerprintSame(t *testing.T) {
	a := &proto.CPUFingerprint{Vendor: "AuthenticAMD", Family: 25, Model: 97, FeaturesHash: "sha256:0123456789abcdef"}
	b := *a
	if !a.Same(&b) {
		t.Fatal("equal fingerprints aren't the same")
	}
	for _, other := range []proto.CPUFingerprint{
		{Vendor: "GenuineIntel", Family: 25, Model: 97, FeaturesHash: a.FeaturesHash},
		{Vendor: a.Vendor, Family: 26, Model: 97, FeaturesHash: a.FeaturesHash},
		{Vendor: a.Vendor, Family: 25, Model: 68, FeaturesHash: a.FeaturesHash},
		{Vendor: a.Vendor, Family: 25, Model: 97, FeaturesHash: "sha256:fedcba9876543210"},
	} {
		if a.Same(&other) {
			t.Fatalf("%+v is the same as %+v", other, *a)
		}
	}
	var none *proto.CPUFingerprint
	if none.Same(a) || a.Same(none) || (&proto.CPUFingerprint{}).Same(&proto.CPUFingerprint{}) {
		t.Fatal("an unknown CPU matches")
	}
}

// TestCPUHere reads this machine's fingerprint twice, from KVM where it can: the same both times, whichever CPU the
// ioctl ran on.
func TestCPUHere(t *testing.T) {
	if _, err := os.Stat("/proc/cpuinfo"); err != nil {
		t.Skip("no /proc/cpuinfo")
	}
	first := CPU()
	if first == nil || first.Vendor == "" || first.FeaturesHash == "" {
		t.Fatalf("CPU() = %+v", first)
	}
	for range 5 {
		if again := CPU(); !first.Same(again) {
			t.Fatalf("CPU() = %+v, then %+v", *first, *again)
		}
	}
	if entries, err := supportedCPUID(); err == nil {
		if len(entries) == 0 {
			t.Fatal("KVM_GET_SUPPORTED_CPUID answered no leaves")
		}
		t.Logf("%d CPUID leaves from KVM: %+v", len(entries), *first)
	} else {
		t.Logf("no KVM CPUID (%v): %+v", err, *first)
	}
}
