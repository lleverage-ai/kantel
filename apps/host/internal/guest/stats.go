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
}

// stats answers Stats.
func (s *Server) stats(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, ReadStats(diskMount, "/proc/pressure/io"))
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
