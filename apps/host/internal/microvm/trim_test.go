package microvm

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
)

// handlerAgent serves handler as a guest agent through a Firecracker-style vsock socket (the CONNECT handshake, then
// HTTP), for a guest.Client to talk to.
func handlerAgent(t *testing.T, handler http.Handler) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "vsock")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	uds := filepath.Join(dir, "v.sock")
	ln, err := net.Listen("unix", uds)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				r := bufio.NewReader(conn)
				if _, err := r.ReadString('\n'); err != nil {
					return
				}
				fmt.Fprint(conn, "OK 1\n")
				for {
					req, err := http.ReadRequest(r)
					if err != nil {
						return
					}
					rec := httptest.NewRecorder()
					handler.ServeHTTP(rec, req)
					res := rec.Result()
					res.ContentLength = int64(rec.Body.Len())
					res.Body = io.NopCloser(bytes.NewReader(rec.Body.Bytes()))
					if err := res.Write(conn); err != nil {
						return
					}
				}
			}()
		}
	}()
	return uds
}

// The guest agent ships in the sandbox image, not with the host, so a new host meets agents from before POST
// /disk/trim. Their 404 (a mux without the route), and a disk without discard's 501, are no trim, at once and quietly:
// the save neither waits out trimWait nor logs anything above debug.
func TestTrimBeforeASaveWithAnAgentThatCantTrim(t *testing.T) {
	old := http.NewServeMux()
	old.HandleFunc("POST /sync", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, `{"ok":true}`) })
	noDiscard := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusNotImplemented)
		_, _ = io.WriteString(w, `{"error":"trim /disk: operation not supported"}`)
	})
	trims := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/disk/trim" {
			http.NotFound(w, r)
			return
		}
		_, _ = io.WriteString(w, `{"trimmed":4096}`)
	})
	for _, tc := range []struct {
		name    string
		handler http.Handler
		trimmed bool
	}{
		{"an agent from before trim", old, false},
		{"a disk without discard", noDiscard, false},
		{"a trim still running", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"error":"a trim of the disk is already running"}`)
		}), false},
		{"an agent that trims", trims, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			m := &Manager{log: slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelInfo}))}
			client := guest.NewClient(handlerAgent(t, tc.handler))
			defer client.Close()
			start := time.Now()
			got := m.trimGuestDisk(context.Background(), "sbx_trim", client)
			if took := time.Since(start); took > 2*time.Second {
				t.Fatalf("the trim took %v", took)
			}
			if got != tc.trimmed {
				t.Fatalf("trimmed %v, want %v", got, tc.trimmed)
			}
			if !tc.trimmed && logs.Len() > 0 {
				t.Fatalf("logged for a guest that can't trim: %s", logs.String())
			}
			if tc.trimmed && !strings.Contains(logs.String(), "trimmed the disk") {
				t.Fatalf("no log of the trim: %s", logs.String())
			}
		})
	}
}
