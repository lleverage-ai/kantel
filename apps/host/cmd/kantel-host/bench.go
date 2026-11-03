package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/agent"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// bench measures sandbox create, resume and fork on this host, on the tiers it runs, cold and warm, without a
// control plane. Each measured operation is timed around the host's own call (what a control plane's call costs
// on the host, without the network to it).
func bench(args []string) error {
	fs := flag.NewFlagSet("bench", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath, "host config")
	runs := fs.Int("runs", 10, "runs of each warm measurement")
	tiers := fs.String("tiers", "", "tiers to measure (default: every tier the host runs)")
	size := fs.String("size", "default", "microVM size")
	out := fs.String("out", "", "also write the results as JSON here")
	_ = fs.Parse(args)
	cfg, err := agent.LoadConfig(*configPath)
	if err != nil {
		return err
	}
	cfg.ControlPlane = ""
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	host, err := agent.New(cfg, version, log)
	if err != nil {
		return err
	}
	defer host.Close()
	ctx := context.Background()
	want := host.Tiers()
	if *tiers != "" {
		want = strings.Split(*tiers, ",")
	}
	results := []benchResult{}
	add := func(r benchResult) {
		results = append(results, r)
		fmt.Fprintf(os.Stderr, "%-8s %-6s %-7s n=%-3d p50=%8.1fms min=%8.1fms max=%8.1fms  %s\n", r.Tier, r.Temp, r.Op, len(r.Samples), r.P50, r.Min, r.Max, r.Note)
	}
	for _, tier := range want {
		rs, err := benchTier(ctx, host, tier, *size, *runs)
		for _, r := range rs {
			add(r)
		}
		if err != nil {
			return fmt.Errorf("%s: %w", tier, err)
		}
	}
	raw, _ := json.MarshalIndent(map[string]any{"host": hostSummary(host), "at": time.Now().UTC().Format(time.RFC3339), "results": results}, "", "  ")
	if *out != "" {
		if err := os.WriteFile(*out, raw, 0o644); err != nil {
			return err
		}
	}
	_, _ = os.Stdout.Write(append(raw, '\n'))
	return nil
}

func hostSummary(host *agent.Host) map[string]any {
	f := host.Facts()
	return map[string]any{"hostname": f.Hostname, "kernel": f.Kernel, "cpus": f.CPUs, "memoryMiB": f.MemoryMiB, "nested": f.Nested, "version": f.Version, "cpu": cpuModel()}
}

func cpuModel() string {
	raw, _ := os.ReadFile("/proc/cpuinfo")
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "model name") {
			if i := strings.Index(line, ":"); i >= 0 {
				return strings.TrimSpace(line[i+1:])
			}
		}
	}
	return ""
}

type benchResult struct {
	Tier    string               `json:"tier"`
	Op      string               `json:"op"`
	Temp    string               `json:"temp"`
	Samples []float64            `json:"samplesMs"`
	P50     float64              `json:"p50Ms"`
	Min     float64              `json:"minMs"`
	Max     float64              `json:"maxMs"`
	Note    string               `json:"note,omitempty"`
	Steps   []map[string]float64 `json:"steps,omitempty"`
}

func summarise(tier, op, temp, note string, samples []float64, steps []map[string]float64) benchResult {
	sorted := append([]float64{}, samples...)
	sort.Float64s(sorted)
	r := benchResult{Tier: tier, Op: op, Temp: temp, Samples: samples, Note: note, Steps: steps}
	if len(sorted) > 0 {
		r.P50 = sorted[len(sorted)/2]
		r.Min, r.Max = sorted[0], sorted[len(sorted)-1]
	}
	for i := range r.Samples {
		r.Samples[i] = math.Round(r.Samples[i]*10) / 10
	}
	return r
}

func ms(since time.Time) float64 { return float64(time.Since(since).Microseconds()) / 1000 }

func benchTier(ctx context.Context, host *agent.Host, tier, size string, runs int) ([]benchResult, error) {
	var out []benchResult
	id := func(kind string, i int) string {
		return fmt.Sprintf("bench-%s-%s-%d-%d", tier, kind, i, time.Now().UnixNano()%1e6)
	}
	call := func(method string, params any, result any) (float64, error) {
		raw, _ := json.Marshal(params)
		start := time.Now()
		res, err := host.Call(ctx, method, raw, nil)
		elapsed := ms(start)
		if err != nil {
			return elapsed, err
		}
		if info, ok := result.(*proto.SandboxInfo); ok {
			*info = proto.SandboxInfo{} // not last call's timings
		}
		if result != nil {
			encoded, _ := json.Marshal(res)
			_ = json.Unmarshal(encoded, result)
		}
		return elapsed, nil
	}
	created := []string{}
	defer func() {
		for _, sid := range created {
			_, _ = call(proto.MethodDelete, proto.SandboxRef{SandboxID: sid}, nil)
		}
	}()
	exec := func(sid string) error {
		var res proto.ExecResult
		if _, err := call(proto.MethodExec, proto.ExecParams{SandboxID: sid, Command: "echo ok"}, &res); err != nil {
			return err
		}
		if strings.TrimSpace(res.Stdout) != "ok" {
			return fmt.Errorf("exec in %s said %q (stderr %q)", sid, res.Stdout, res.Stderr)
		}
		return nil
	}
	host.SetPools(map[string]int{})
	host.ResetTemplates(tier)

	// Cold create: nothing prepared (no template snapshot, no pool): the first sandbox of a fresh host.
	var info proto.SandboxInfo
	sid := id("cold", 0)
	t, err := call(proto.MethodCreate, proto.CreateParams{SandboxID: sid, Tier: tier, Size: size}, &info)
	if err != nil {
		return out, fmt.Errorf("cold create: %w", err)
	}
	created = append(created, sid)
	if err := exec(sid); err != nil {
		return out, err
	}
	out = append(out, summarise(tier, "create", "cold", "first sandbox on a fresh host: boots the template, then restores it ("+info.Source+")", []float64{t}, []map[string]float64{info.Timings}))

	// Create from the template snapshot, no pool.
	var samples []float64
	var steps []map[string]float64
	for i := 0; i < runs; i++ {
		sid := id("snap", i)
		t, err := call(proto.MethodCreate, proto.CreateParams{SandboxID: sid, Tier: tier, Size: size}, &info)
		if err != nil {
			return out, fmt.Errorf("create from template: %w", err)
		}
		created = append(created, sid)
		samples, steps = append(samples, t), append(steps, info.Timings)
		if err := exec(sid); err != nil {
			return out, err
		}
	}
	out = append(out, summarise(tier, "create", "snapshot", "no warm pool: restores the template snapshot", samples, steps))

	// Warm: from a pre-warmed pool.
	pool := tier + "/" + size
	if tier == "isolate" {
		pool = tier + "/default"
	}
	host.SetPools(map[string]int{pool: runs})
	deadline := time.Now().Add(5 * time.Minute)
	for host.Warm()[pool] < runs && time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
	}
	samples, steps = nil, nil
	for i := 0; i < runs; i++ {
		sid := id("warm", i)
		t, err := call(proto.MethodCreate, proto.CreateParams{SandboxID: sid, Tier: tier, Size: size}, &info)
		if err != nil {
			return out, fmt.Errorf("warm create: %w", err)
		}
		created = append(created, sid)
		samples, steps = append(samples, t), append(steps, info.Timings)
		if err := exec(sid); err != nil {
			return out, err
		}
		// Let the pool refill between runs, as it would between real creates.
		for host.Warm()[pool] < runs-i-1 && time.Now().Before(deadline) {
			time.Sleep(50 * time.Millisecond)
		}
	}
	host.SetPools(map[string]int{})
	out = append(out, summarise(tier, "create", "warm", "claimed from the pre-warmed pool", samples, steps))

	// Stop and resume (with memory where the tier keeps it), then stop without memory and start (cold).
	target := created[1]
	samples, steps = nil, nil
	var stopSamples []float64
	// An isolate keeps no memory (its /workspace is what persists), so it has only the cold stop and start below.
	paused := runs
	if tier == "isolate" {
		paused = 0
	}
	for i := 0; i < paused; i++ {
		keep := true
		t, err := call(proto.MethodStop, proto.StopParams{SandboxID: target, SnapshotID: id("stop", i), Memory: &keep}, nil)
		if err != nil {
			return out, fmt.Errorf("stop: %w", err)
		}
		stopSamples = append(stopSamples, t)
		t, err = call(proto.MethodResume, proto.ResumeParams{SandboxID: target}, &info)
		if err != nil {
			return out, fmt.Errorf("resume: %w", err)
		}
		samples, steps = append(samples, t), append(steps, info.Timings)
		if err := exec(target); err != nil {
			return out, err
		}
	}
	if paused > 0 {
		out = append(out, summarise(tier, "stop", "warm", "pause: snapshot memory and disk", stopSamples, nil))
		out = append(out, summarise(tier, "resume", "warm", "from its own memory snapshot ("+info.Source+")", samples, steps))
	}
	samples, steps = nil, nil
	for i := 0; i < min(runs, 3); i++ {
		keep := false
		if _, err := call(proto.MethodStop, proto.StopParams{SandboxID: target, SnapshotID: id("stopc", i), Memory: &keep}, nil); err != nil {
			return out, fmt.Errorf("stop: %w", err)
		}
		t, err := call(proto.MethodStart, proto.ResumeParams{SandboxID: target}, &info)
		if err != nil {
			return out, fmt.Errorf("start: %w", err)
		}
		samples, steps = append(samples, t), append(steps, info.Timings)
		if err := exec(target); err != nil {
			return out, err
		}
	}
	out = append(out, summarise(tier, "resume", "cold", "stopped without memory: boots from its disk ("+info.Source+")", samples, steps))

	// Fork a running sandbox (live snapshot, then a clone restores it).
	samples, steps = nil, nil
	for i := 0; i < runs; i++ {
		nid := id("fork", i)
		t, err := call(proto.MethodFork, proto.ForkParams{SandboxID: target, NewID: nid, SnapshotID: id("forksnap", i)}, &info)
		if err != nil {
			return out, fmt.Errorf("fork: %w", err)
		}
		created = append(created, nid)
		samples, steps = append(samples, t), append(steps, info.Timings)
		if err := exec(nid); err != nil {
			return out, err
		}
	}
	out = append(out, summarise(tier, "fork", "warm", "of a running sandbox: live snapshot + restore", samples, steps))
	return out, nil
}

var _ = io.Discard
