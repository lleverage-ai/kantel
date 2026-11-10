package microvm

import (
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
)

// A sync waits out the kernel's cache timeout only when the guest didn't say, for a mount it synced, that the kernel
// already forgot the changed names (an older guest agent); a mount it didn't sync doesn't count.
func TestAllCurrent(t *testing.T) {
	synced := map[string]int64{"/mnt/a": 1, "/mnt/b": 2}
	for name, c := range map[string]struct {
		results []guest.MountResult
		want    bool
	}{
		"all said":       {[]guest.MountResult{{Path: "/mnt/a", Current: true}, {Path: "/mnt/b", Current: true}}, true},
		"one didn't":     {[]guest.MountResult{{Path: "/mnt/a", Current: true}, {Path: "/mnt/b"}}, false},
		"an older guest": {[]guest.MountResult{{Path: "/mnt/a"}, {Path: "/mnt/b"}}, false},
		"one not synced": {[]guest.MountResult{{Path: "/mnt/a", Current: true}, {Path: "/mnt/b", Current: true}, {Path: "/mnt/c"}}, true},
	} {
		if got := allCurrent(synced, c.results); got != c.want {
			t.Errorf("%s: %v, want %v", name, got, c.want)
		}
	}
}
