package disksync

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Limiter holds a direction of peer sync to a rate (--sync-rate): bytes each Wait lets through come at most at that
// rate, with up to a quarter of a second's worth at once. A nil Limiter, or one of rate 0, holds nothing back.
type Limiter struct {
	mu sync.Mutex
	// rate is in bytes per second; next is when the bytes let through so far will have been paid for.
	rate float64
	next time.Time
}

// NewLimiter is a limiter of bytesPerSecond, none for 0 or less.
func NewLimiter(bytesPerSecond int64) *Limiter {
	if bytesPerSecond <= 0 {
		return nil
	}
	return &Limiter{rate: float64(bytesPerSecond)}
}

// burst is how far ahead of its rate a limiter lets bytes through.
const burst = 250 * time.Millisecond

// Wait waits until n more bytes may go, or ctx ends.
func (l *Limiter) Wait(ctx context.Context, n int) error {
	if l == nil || n <= 0 {
		return nil
	}
	l.mu.Lock()
	now := time.Now()
	if l.next.Before(now.Add(-burst)) {
		l.next = now.Add(-burst)
	}
	cost := time.Duration(float64(n) / l.rate * float64(time.Second))
	l.next = l.next.Add(cost)
	wait := l.next.Sub(now)
	l.mu.Unlock()
	if wait <= 0 {
		return nil
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		// The bytes don't go: their time is given back, for the waits after it.
		l.mu.Lock()
		l.next = l.next.Add(-cost)
		l.mu.Unlock()
		return ctx.Err()
	}
}

// chunk is the most a limited reader or writer passes at once.
const chunk = 256 << 10

// limitedReader reads r at l's rate.
type limitedReader struct {
	ctx context.Context
	r   io.Reader
	l   *Limiter
}

func (lr limitedReader) Read(p []byte) (int, error) {
	if len(p) > chunk {
		p = p[:chunk]
	}
	n, err := lr.r.Read(p)
	if werr := lr.l.Wait(lr.ctx, n); werr != nil && err == nil {
		err = werr
	}
	return n, err
}

// limitedWriter writes a response at l's rate.
type limitedWriter struct {
	http.ResponseWriter
	ctx context.Context
	l   *Limiter
}

func (lw limitedWriter) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		n := min(len(p), chunk)
		if err := lw.l.Wait(lw.ctx, n); err != nil {
			return written, err
		}
		n, err := lw.ResponseWriter.Write(p[:n])
		written += n
		if err != nil {
			return written, err
		}
		p = p[n:]
	}
	return written, nil
}

// Unwrap lets http.ResponseController reach the response's own writer.
func (lw limitedWriter) Unwrap() http.ResponseWriter { return lw.ResponseWriter }

// DefaultRate is the default --sync-rate, in bytes per second: half the link the host's default route goes over (its
// speed, from /sys/class/net), or half of 1 Gbit/s when that can't be read.
func DefaultRate() int64 {
	mbit := linkSpeed("/proc/net/route", "/sys/class/net")
	if mbit <= 0 {
		mbit = 1000
	}
	return mbit * 1_000_000 / 8 / 2
}

// linkSpeed is the speed, in Mbit/s, of the interface of the default IPv4 route in routes (/proc/net/route's format),
// read from sys; 0 when it can't be read.
func linkSpeed(routes, sys string) int64 {
	raw, err := os.ReadFile(routes)
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n")[1:] {
		f := strings.Fields(line)
		// Iface, Destination 00000000 and Mask 00000000: the default route.
		if len(f) < 8 || f[1] != "00000000" || f[7] != "00000000" {
			continue
		}
		speed, err := os.ReadFile(filepath.Join(sys, filepath.Base(f[0]), "speed"))
		if err != nil {
			return 0
		}
		mbit, err := strconv.ParseInt(strings.TrimSpace(string(speed)), 10, 64)
		if err != nil || mbit <= 0 {
			return 0
		}
		return mbit
	}
	return 0
}
