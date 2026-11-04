package e2e

import (
	"crypto/ecdh"
	"encoding/json"
	"errors"
	"io"
)

// Client is a device's side of a session, in Go: for the host's own tests (devices run the TypeScript one).
type Client struct {
	s    *secure
	next int
}

// OpenClient opens an rpc session to hostID as the device whose Noise key is static, bringing the host entries
// (the whole chain; the host takes those it lacks).
func OpenClient(conn io.ReadWriteCloser, static *ecdh.PrivateKey, hostStatic []byte, space, hostID, sandbox string, entries []Entry) (*Client, error) {
	in := &Initiator{Prologue: Prologue(space, hostID), Static: static, RemoteStatic: hostStatic}
	hello, _ := json.Marshal(Hello{V: SessionVersion, Sandbox: sandbox, Op: "rpc"})
	m1, err := in.WriteMessage1(hello)
	if err != nil {
		return nil, err
	}
	if _, err := conn.Write(frame2(m1)); err != nil {
		return nil, err
	}
	m2, err := readRecord(conn)
	if err != nil {
		return nil, err
	}
	payload, t, err := in.ReadMessage2(m2)
	if err != nil {
		return nil, errors.New("the answer didn't come from the host's key")
	}
	var head struct {
		Head struct {
			Seq int `json:"seq"`
		} `json:"head"`
	}
	if err := json.Unmarshal(payload, &head); err != nil {
		return nil, err
	}
	s := &secure{conn: conn, t: t}
	open := map[string]any{"type": "open"}
	if from := head.Head.Seq + 1; from < len(entries) {
		open["chain"] = map[string]any{"from": from, "entries": entries[from:]}
	}
	if err := s.send(open); err != nil {
		return nil, err
	}
	raw, err := s.next()
	if err != nil {
		return nil, err
	}
	var reply refused
	_ = json.Unmarshal(raw, &reply)
	if reply.Type != "ready" {
		return nil, errors.New(reply.Reason)
	}
	return &Client{s: s}, nil
}

// Call runs method and gives its result, skipping its events.
func (c *Client) Call(method string, params any) (json.RawMessage, error) {
	c.next++
	if err := c.s.send(map[string]any{"id": c.next, "method": method, "params": params}); err != nil {
		return nil, err
	}
	for {
		raw, err := c.s.next()
		if err != nil {
			return nil, err
		}
		var m struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *Error          `json:"error"`
			Event  json.RawMessage `json:"event"`
		}
		if json.Unmarshal(raw, &m) != nil || m.ID != c.next || m.Event != nil {
			continue
		}
		if m.Error != nil {
			return nil, m.Error
		}
		return m.Result, nil
	}
}

func (c *Client) Close() error { return c.s.conn.Close() }
