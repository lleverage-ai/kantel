package fc

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// fakeAPI is a Firecracker API on dir's api.sock that records what it is sent and answers GET /balloon/statistics
// with stats (or 400, as Firecracker does for a VM without a balloon, when stats is "").
type fakeAPI struct {
	mu    sync.Mutex
	puts  map[string]map[string]any
	order []string
	stats string
}

func serveFake(t *testing.T, stats string) (string, *fakeAPI) {
	t.Helper()
	// A short directory: a Unix socket's path is at most 108 bytes.
	dir, err := os.MkdirTemp("", "fc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	ln, err := net.Listen("unix", filepath.Join(dir, APISocket))
	if err != nil {
		t.Fatal(err)
	}
	api := &fakeAPI{puts: map[string]map[string]any{}, stats: stats}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		api.mu.Lock()
		defer api.mu.Unlock()
		if r.Method == http.MethodGet && r.URL.Path == "/balloon/statistics" {
			if api.stats == "" {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"fault_message":"The requested operation is not supported without a balloon device."}`)
				return
			}
			_, _ = io.WriteString(w, api.stats)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		api.puts[r.URL.Path] = body
		api.order = append(api.order, r.Method+" "+r.URL.Path)
		w.WriteHeader(http.StatusNoContent)
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { srv.Close() })
	return dir, api
}

func TestBootAddsAReportingBalloon(t *testing.T) {
	dir, api := serveFake(t, "")
	m := &Machine{Dir: dir, http: apiClient(dir)}
	cfg := BootConfig{VCPUs: 2, MemoryMiB: 2048, Kernel: "vmlinux", TapDevice: "tap0", MAC: "06:00:00:00:00:01", GuestCID: 3, BalloonStatsSeconds: 1}
	if err := m.Boot(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	b, ok := api.puts["/balloon"]
	if !ok {
		t.Fatalf("no balloon: %v", api.order)
	}
	// Nothing taken from the guest, given back on OOM if ever set, its figures refreshed every second.
	if b["amount_mib"] != float64(0) || b["deflate_on_oom"] != true || b["stats_polling_interval_s"] != float64(1) {
		t.Fatalf("balloon %v", b)
	}
	// Every device before the start.
	if last := api.order[len(api.order)-1]; last != "PUT /actions" {
		t.Fatalf("order %v", api.order)
	}
}

func TestBootWithoutBalloonStats(t *testing.T) {
	// The isolate tier's VM asks for none.
	dir, api := serveFake(t, "")
	m := &Machine{Dir: dir, http: apiClient(dir)}
	if err := m.Boot(context.Background(), BootConfig{VCPUs: 1, MemoryMiB: 512, Kernel: "vmlinux", GuestCID: 3}); err != nil {
		t.Fatal(err)
	}
	if _, ok := api.puts["/balloon"]; ok {
		t.Fatalf("a balloon nobody asked for: %v", api.order)
	}
}

// Discard is on the writable disk only when asked: a Firecracker before v1.17 refuses the field.
func TestBootDiscard(t *testing.T) {
	for _, discard := range []bool{false, true} {
		dir, api := serveFake(t, "")
		m := &Machine{Dir: dir, http: apiClient(dir)}
		if err := m.Boot(context.Background(), BootConfig{VCPUs: 1, MemoryMiB: 512, Kernel: "vmlinux", GuestCID: 3, Discard: discard}); err != nil {
			t.Fatal(err)
		}
		disk := api.puts["/drives/disk"]
		// Barrier, and so a disk-only snapshot's copy, rely on the Sync engine: said outright, never left to a default.
		if disk["io_engine"] != "Sync" {
			t.Fatalf("the disk's IO engine is %v, not Sync", disk["io_engine"])
		}
		if got, ok := disk["discard"]; discard && got != true || !discard && ok {
			t.Fatalf("discard %v: disk drive %v", discard, disk)
		}
		if _, ok := api.puts["/drives/rootfs"]["discard"]; ok {
			t.Fatalf("discard on the read-only rootfs: %v", api.puts["/drives/rootfs"])
		}
	}
}

func TestDiscardSupported(t *testing.T) {
	for version, want := range map[string]bool{"v1.17.0": true, "v1.18.2": true, "v2.0.0": true, "v1.16.1": false, "v1.10.0": false, "": false, "unknown": false} {
		if got := DiscardSupported(version); got != want {
			t.Errorf("DiscardSupported(%q) = %v, want %v", version, got, want)
		}
	}
}

// A restore leaves kvmclock where the snapshot had it: advanced by the time since (clock_realtime), it jumps the
// guest's scheduler clock, and a 1-vCPU guest's agent answered seconds late (TASK-5137).
func TestLoadDoesNotAdvanceKvmclock(t *testing.T) {
	dir, api := serveFake(t, "")
	m := &Machine{Dir: dir, http: apiClient(dir)}
	if err := m.Load(context.Background(), "state", "mem", "tap0"); err != nil {
		t.Fatal(err)
	}
	body, ok := api.puts["/snapshot/load"]
	if !ok {
		t.Fatalf("no snapshot load: %v", api.order)
	}
	if body["clock_realtime"] != false || body["resume_vm"] != true {
		t.Fatalf("snapshot load %v", body)
	}
}

func TestReadBalloonStats(t *testing.T) {
	// What Firecracker v1.17 answers (sizes in bytes, the balloon's in pages and MiB).
	dir, _ := serveFake(t, `{"target_pages":0,"actual_pages":0,"target_mib":0,"actual_mib":0,"swap_in":0,"swap_out":0,`+
		`"major_faults":1200,"minor_faults":900000,"free_memory":1200000000,"total_memory":2068000000,`+
		`"available_memory":1500000000,"disk_caches":400000000,"hugetlb_allocations":0,"hugetlb_failures":0}`)
	stats, err := ReadBalloonStats(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if stats.TotalMemory == nil || *stats.TotalMemory != 2_068_000_000 || stats.AvailableMemory == nil ||
		*stats.AvailableMemory != 1_500_000_000 || stats.FreeMemory == nil || *stats.FreeMemory != 1_200_000_000 {
		t.Fatalf("stats %+v", stats)
	}

	// Before the guest's driver has reported, only the balloon's own sizes are there.
	dir, _ = serveFake(t, `{"target_pages":0,"actual_pages":0,"target_mib":0,"actual_mib":0}`)
	stats, err = ReadBalloonStats(context.Background(), dir)
	if err != nil || stats.TotalMemory != nil || stats.AvailableMemory != nil {
		t.Fatalf("unreported: %+v %v", stats, err)
	}
}

func TestReadBalloonStatsWithoutABalloon(t *testing.T) {
	dir, _ := serveFake(t, "")
	if _, err := ReadBalloonStats(context.Background(), dir); err == nil {
		t.Fatal("a VM without a balloon has no statistics")
	}
	// Nor does a directory with no Firecracker in it.
	if _, err := ReadBalloonStats(context.Background(), t.TempDir()); err == nil {
		t.Fatal("no API socket")
	}
}
