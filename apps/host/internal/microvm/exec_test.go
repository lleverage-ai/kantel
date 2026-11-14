package microvm

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// cutAgent is a guest agent through a Firecracker-style vsock socket that takes each exec and answers none: its
// connection is cut once cut is closed, as a stop's breaks it, or with refuse it then answers a refusal. Each exec's
// request is sent on asked.
func cutAgent(t *testing.T, asked chan<- guest.ExecRequest, cut <-chan struct{}, refuse bool) string {
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
				req, err := http.ReadRequest(r)
				if err != nil {
					return
				}
				var exec guest.ExecRequest
				_ = json.NewDecoder(req.Body).Decode(&exec)
				asked <- exec
				<-cut
				if refuse {
					body := `{"error":"chdir /nowhere: no such file or directory"}`
					fmt.Fprintf(conn, "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s", len(body), body)
				}
			}()
		}
	}()
	return uds
}

// A command with an ID whose call to the guest broke as its sandbox was stopped keeping its memory is answered
// suspended: it was kept past its connection (Keep), so it carries on in that memory. A call that broke otherwise, or
// that the guest answered with a refusal, is the error it came to.
func TestAnExecBrokenByAStopThatKeepsMemoryIsSuspended(t *testing.T) {
	for _, tc := range []struct {
		name      string
		keeps     bool
		refused   bool
		suspended bool
	}{
		{"a stop that keeps its memory", true, false, true},
		{"its connection going otherwise", false, false, false},
		{"a refusal the guest answered as the stop came", true, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			asked := make(chan guest.ExecRequest, 1)
			cut := make(chan struct{})
			s := &sandbox{meta: meta{ID: "sbx_e", State: proto.StateRunning}, guest: guest.NewClient(cutAgent(t, asked, cut, tc.refused))}
			m := &Manager{sandboxes: map[string]*sandbox{"sbx_e": s}}
			answered := make(chan error, 1)
			go func() {
				_, err := m.Exec(context.Background(), proto.ExecParams{SandboxID: "sbx_e", Command: "make", CommandID: "cmd_e"}, nil)
				answered <- err
			}()
			if req := <-asked; !req.Keep || req.ID != "cmd_e" {
				t.Fatalf("the guest was asked %+v", req)
			}
			// As Stop does: under its lock, the machine let go, its memory kept, then the connection cut.
			s.mu.Lock()
			if tc.keeps {
				s.suspends++
			}
			close(cut)
			s.mu.Unlock()
			err := <-answered
			var pe *proto.Error
			if got := errors.As(err, &pe) && pe.Code == proto.ErrSuspended; got != tc.suspended || err == nil {
				t.Fatalf("answered %v, suspended %v", err, got)
			}
		})
	}
}
