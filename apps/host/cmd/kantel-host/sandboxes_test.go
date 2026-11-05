package main

import (
	"bytes"
	"context"
	"flag"
	"log/slog"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/agent"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

type fakeSandboxes []proto.SandboxInfo

func (f fakeSandboxes) List() []proto.SandboxInfo { return f }

func (f fakeSandboxes) Sandbox(id string) (proto.SandboxInfo, error) {
	for _, s := range f {
		if s.ID == id {
			return s, nil
		}
	}
	return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrNotFound, Message: "no sandbox " + id + " on this host"}
}

var now = time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)

func before(d time.Duration) int64 { return now.Add(-d).UnixMilli() }

func TestSandboxesTable(t *testing.T) {
	var out bytes.Buffer
	printSandboxes(&out, []proto.SandboxInfo{
		{ID: "sb_newer", Tier: "isolate", Size: "small", State: "stopped", Owner: "acc_2", CreatedAt: before(90 * time.Second)},
		{ID: "sb_older", Tier: "microvm", Size: "medium", State: "running", Owner: "acc_1", Base: "2026.11.1",
			Address: "10.231.0.2", CreatedAt: before(3 * time.Hour)},
	}, now)
	want := "" +
		"id        tier     size    state    owner  base       address     created\n" +
		"sb_older  microvm  medium  running  acc_1  2026.11.1  10.231.0.2  3h ago\n" +
		"sb_newer  isolate  small   stopped  acc_2  -          -           1m ago\n"
	if out.String() != want {
		t.Errorf("table:\n%s\nwant:\n%s", out.String(), want)
	}
	out.Reset()
	printSandboxes(&out, nil, now)
	if out.String() != "No sandboxes on this host.\n" {
		t.Errorf("empty: %q", out.String())
	}
}

func TestSandboxShow(t *testing.T) {
	var out bytes.Buffer
	printSandbox(&out, proto.SandboxInfo{ID: "sb_1", Tier: "microvm", Size: "small", State: "stopped", Memory: true,
		CreatedAt: before(72 * time.Hour), Mounts: []proto.MountStatus{{Path: "/data", Kind: "bucket", State: "ready"}}}, now)
	for _, want := range []string{
		"state         stopped (memory kept)\n",
		"created       2026-11-02T12:00:00Z (3d ago)\n",
		"mounts        /data (bucket) ready\n",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("show has no %q:\n%s", want, out.String())
		}
	}
	if strings.Contains(out.String(), "address") {
		t.Errorf("an empty field printed:\n%s", out.String())
	}
}

func TestStateCounts(t *testing.T) {
	got := stateCounts([]proto.SandboxInfo{{State: "running"}, {State: "stopped"}, {State: "running"}})
	if got != "3 (2 running, 1 stopped)" {
		t.Errorf("counts: %q", got)
	}
	if stateCounts(nil) != "none" {
		t.Errorf("none: %q", stateCounts(nil))
	}
}

func TestParseInterspersed(t *testing.T) {
	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "")
	if rest := parseInterspersed(fs, []string{"sb_1", "--json"}); !reflect.DeepEqual(rest, []string{"sb_1"}) || !*asJSON {
		t.Errorf("rest %v, json %v", rest, *asJSON)
	}
}

// The client reads the daemon's socket, says what a missing sandbox is, and what a missing socket most likely means.
func TestControlClient(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.sock")
	ctx := context.Background()
	if _, err := (controlClient{path: path}).list(ctx); err == nil || !strings.Contains(err.Error(), "is the service running") {
		t.Errorf("no socket: %v", err)
	}
	stop, err := agent.ServeControl(path, fakeSandboxes{{ID: "sb_1", State: "running"}}, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	c := controlClient{path: path}
	if list, err := c.list(ctx); err != nil || len(list) != 1 || list[0].ID != "sb_1" {
		t.Fatalf("list: %v %v", list, err)
	}
	if s, err := c.sandbox(ctx, "sb_1"); err != nil || s.State != "running" {
		t.Fatalf("show: %v %v", s, err)
	}
	if _, err := c.sandbox(ctx, "sb_2"); err == nil || err.Error() != "no sandbox sb_2 on this host" {
		t.Errorf("missing: %v", err)
	}
	if got := sandboxesLine(agent.Config{ControlSocket: path}); got != "1 (1 running)" {
		t.Errorf("status line: %q", got)
	}
	if got := sandboxesLine(agent.Config{ControlSocket: path + ".gone"}); !strings.HasPrefix(got, "unknown: no control socket") {
		t.Errorf("status line without the service: %q", got)
	}
}
