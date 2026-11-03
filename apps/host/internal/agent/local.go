package agent

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
)

// LocalHandler serves the host's calls over plain HTTP, for tests and for running a host with no control plane:
//
//	POST /call/<method>        body: the call's params; answer: its result, or {"error": {...}}
//	GET  /facts, /capacity
//	GET  /port/<sandbox>/<port> (Upgrade: tcp)  a raw stream to the sandbox's port
//
// It has no authentication: listen on loopback only.
func (h *Host) LocalHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /call/{method}", func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if len(raw) == 0 {
			raw = []byte("{}")
		}
		result, err := h.Call(r.Context(), r.PathValue("method"), raw, nil)
		w.Header().Set("content-type", "application/json")
		if err != nil {
			pe := toError(err)
			status := 500
			switch pe.Code {
			case "not_found":
				status = 404
			case "invalid":
				status = 400
			case "conflict":
				status = 409
			case "unsupported":
				status = 501
			}
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": pe})
			return
		}
		_ = json.NewEncoder(w).Encode(result)
	})
	mux.HandleFunc("GET /facts", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(h.Facts())
	})
	mux.HandleFunc("GET /capacity", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(h.Capacity())
	})
	mux.HandleFunc("GET /port/{sandbox}/{port}", func(w http.ResponseWriter, r *http.Request) {
		port, err := strconv.Atoi(r.PathValue("port"))
		if err != nil || !strings.EqualFold(r.Header.Get("Upgrade"), "tcp") {
			http.Error(w, "want Upgrade: tcp and a port", 400)
			return
		}
		conn, err := h.DialPort(r.Context(), r.PathValue("sandbox"), port)
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		hj, ok := w.(http.Hijacker)
		if !ok {
			conn.Close()
			http.Error(w, "can't hijack", 500)
			return
		}
		client, buf, err := hj.Hijack()
		if err != nil {
			conn.Close()
			return
		}
		_, _ = io.WriteString(client, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: tcp\r\nConnection: Upgrade\r\n\r\n")
		if n := buf.Reader.Buffered(); n > 0 {
			pending, _ := buf.Reader.Peek(n)
			_, _ = conn.Write(pending)
		}
		splice(client, conn)
	})
	return mux
}

func splice(a, b net.Conn) {
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if c, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		} else {
			_ = dst.Close()
		}
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	<-done
	a.Close()
	b.Close()
}
