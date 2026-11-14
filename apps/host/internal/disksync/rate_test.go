package disksync

import (
	"net/netip"
	"testing"
	"time"
)

// A fetch's rate is kept for its peer only when it took enough from that peer alone.
func TestAFetchsRateIsKeptForItsPeer(t *testing.T) {
	f := &Fetcher{}
	one := netip.MustParseAddr("fd7a::2")
	two := netip.MustParseAddr("fd7a::3")
	f.noteRate(&holders{list: []netip.Addr{one}}, rateMinBytes-1, time.Second)
	f.noteRate(&holders{list: []netip.Addr{one, two}}, 4*rateMinBytes, time.Second)
	if len(f.Rates()) != 0 {
		t.Fatalf("rates = %v", f.Rates())
	}
	f.noteRate(&holders{list: []netip.Addr{one}}, 2*rateMinBytes, 2*time.Second)
	r := f.Rates()[one]
	if r.BytesPerSecond != rateMinBytes || r.At.IsZero() || len(f.Rates()) != 1 {
		t.Fatalf("rates = %v", f.Rates())
	}
}
