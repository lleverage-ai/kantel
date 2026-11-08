package guest

import (
	"bufio"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// Stats is what the guest says of its own disk and IO when the host asks (GET /stats, each usage tick): what can't be
// read from outside the VM.
type Stats struct {
	// DiskUsedBytes and DiskTotalBytes are the sandbox's own disk (/disk, which its root's writable layer, Docker and
	// containerd are on) as df counts it: used is what isn't free, the root-reserved blocks included. Both 0 when it
	// can't be read.
	DiskUsedBytes  int64 `json:"diskUsedBytes"`
	DiskTotalBytes int64 `json:"diskTotalBytes"`
	// IOSomeMicros is /proc/pressure/io's "some" total: the microseconds since boot in which at least one task waited on
	// IO. A difference of two over the time between them is the share of the time IO held something up. Absent when the
	// kernel has no pressure figures (PSI off: a VM booted without psi=1).
	IOSomeMicros *uint64 `json:"ioSomeMicros,omitempty"`
	// OOMKills is /proc/vmstat's oom_kill: how many processes the kernel has killed for memory since boot, those
	// MemoryWatch had it kill included. Absent when it can't be read (and from an agent that predates it).
	OOMKills *int64 `json:"oomKills,omitempty"`
	// MemorySomeAvg10 and MemoryFullAvg10 are /proc/pressure/memory's avg10s, 0 to 100: the share of the last ten
	// seconds in which at least one task (some), or every task that wanted to run (full), was stalled on memory. Absent
	// without pressure figures (PSI off).
	MemorySomeAvg10 *float64 `json:"memorySomeAvg10,omitempty"`
	MemoryFullAvg10 *float64 `json:"memoryFullAvg10,omitempty"`
}

// stats answers Stats.
func (s *Server) stats(w http.ResponseWriter, _ *http.Request) {
	out := ReadStats(diskMount, "/proc/pressure/io")
	out.ReadMemory("/proc/pressure/memory", "/proc/vmstat")
	writeJSON(w, 200, out)
}

// ReadMemory adds the memory pressure file's avg10s at pressure and the vmstat file's oom_kill at vmstat, each it can
// read.
func (s *Stats) ReadMemory(pressure, vmstat string) {
	if raw, err := os.ReadFile(pressure); err == nil {
		for kind, into := range map[string]**float64{"some": &s.MemorySomeAvg10, "full": &s.MemoryFullAvg10} {
			if v, err := ParsePressureAvg10(strings.NewReader(string(raw)), kind); err == nil && v >= 0 {
				*into = &v
			}
		}
	}
	if n := oomKillsIn(vmstat); n >= 0 {
		s.OOMKills = &n
	}
}

// diskMount is where the guest has its own disk (guestinit and the image path's kantel-init both mount it there).
const diskMount = "/disk"

// ReadStats reads the disk mounted at mount (else /'s) and the IO pressure file at pressure.
func ReadStats(mount, pressure string) Stats {
	var out Stats
	for _, path := range []string{mount, "/"} {
		var st unix.Statfs_t
		if err := unix.Statfs(path, &st); err == nil && st.Blocks > 0 {
			bs := int64(st.Bsize)
			out.DiskTotalBytes, out.DiskUsedBytes = int64(st.Blocks)*bs, int64(st.Blocks-st.Bfree)*bs
			break
		}
	}
	if f, err := os.Open(pressure); err == nil {
		if total, err := ParsePressureSome(f); err == nil {
			out.IOSomeMicros = &total
		}
		_ = f.Close()
	}
	return out
}

// ParsePressureSome reads a /proc/pressure file's "some" line's total=, in microseconds. Reading the file fails
// (EOPNOTSUPP) on a kernel with PSI built in but off.
func ParsePressureSome(r io.Reader) (uint64, error) {
	s := bufio.NewScanner(r)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) == 0 || fields[0] != "some" {
			continue
		}
		for _, f := range fields[1:] {
			if v, ok := strings.CutPrefix(f, "total="); ok {
				return strconv.ParseUint(v, 10, 64)
			}
		}
	}
	if err := s.Err(); err != nil {
		return 0, err
	}
	return 0, errors.New("no some total")
}
