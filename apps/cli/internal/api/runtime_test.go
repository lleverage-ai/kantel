package api

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// A call this client sends once is sent once, even when Go's transport would replay it on a dropped connection.
func TestKeyedCallsOutsideTheListAreNotReplayed(t *testing.T) {
	var posts atomic.Int32
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{}`))
			return
		}
		posts.Add(1)
		// Do it, then drop the connection before answering.
		hj, _ := w.(http.Hijacker)
		conn, _, _ := hj.Hijack()
		_ = conn.Close()
	}))
	srv.Start()
	defer srv.Close()
	c := &Client{BaseURL: srv.URL + "/v1", HTTP: srv.Client()}
	// Warm a connection, so the POST goes on a reused one.
	_ = c.Do(context.Background(), Call{Method: "GET", Path: "/whoami"})
	err := c.Do(context.Background(), Call{Method: "POST", Path: "/accounts/acc_1/invites", Body: map[string]any{}, Idempotent: true})
	if err == nil {
		t.Fatal("no error for a dropped call")
	}
	if n := posts.Load(); n != 1 {
		t.Errorf("sent %d times, want 1", n)
	}
}

// The bearer goes only to the origin it was given for.
func TestRedirectToAnotherOriginIsRefused(t *testing.T) {
	var leaked atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			leaked.Store(true)
		}
	}))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+r.URL.Path, http.StatusFound)
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL + "/v1", Token: "ksk_secret", HTTP: srv.Client(), RetryDelays: nil}
	err := c.Do(context.Background(), Call{Method: "GET", Path: "/whoami"})
	if err == nil || !strings.Contains(err.Error(), "another origin") {
		t.Fatalf("err %v", err)
	}
	if leaked.Load() {
		t.Error("the bearer went to another origin")
	}
}

var _ net.Conn
