package main

import (
	"context"
	"encoding/json"
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
	fs := newFlags("bench")
	configPath := fs.String("config", defaultConfigPath, "The settings `file`")
	runs := fs.Int("runs", 10, "How many runs of each warm measurement: `n`")
	tiers := fs.String("tiers", "", "The `tiers` to measure: microvm, isolate or both, comma-separated (default: every tier the host runs)")
	size := fs.String("size", "default", "The microVM `size` (default: the default size)")
	out := fs.String("out", "", "Also write the results as JSON to this `file`")
	vcpus := fs.Int("vcpus", 0, "A custom shape's vCPUs instead of --size (with --memory and --disk)")
	memory := fs.Int("memory", 0, "A custom shape's memory, `MiB`")
	disk := fs.Int("disk", 0, "A custom shape's disk, `GiB`")
	only := fs.String("only", "", "`create`: measure creates only (no stop, resume or fork)")
	settle := fs.Duration("settle", 0, "Wait this `long` after the host starts, before measuring, such as 30s")
	keep := fs.Bool("keep-templates", false, "Don't drop the templates first: no cold create, and creates restore the templates already made")
	owners := fs.String("owners", "", "`new`: every create is for an account of its own (the isolate tier: an isolate in a just-restored account VM, not one already running)")
	_ = fs.Bool("json", false, "Print the results as JSON (as bench always does: the flag is for scripts that ask)")
	if err := fs.parse(args); err != nil {
		return err
	}
	if err := fs.noArgs(); err != nil {
		return err
	}
	benchOnly, benchKeep, benchOwners = *only, *keep, *owners
	benchShape = proto.CreateParams{Size: *size}
	if *vcpus > 0 {
		benchShape = proto.CreateParams{VCPUs: *vcpus, MemoryMiB: *memory, DiskGiB: *disk}
	}
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
	time.Sleep(*settle)
	want := host.Tiers()
	if *tiers != "" {
		want = strings.Split(*tiers, ",")
	}
	results := []benchResult{}
	add := func(r benchResult) {
		results = append(results, r)
		fmt.Fprintf(os.Stderr, "%-8s %-6s %-7s n=%-3d p50=%8.1fms p95=%8.1fms min=%8.1fms max=%8.1fms  %s\n", r.Tier, r.Temp, r.Op, len(r.Samples), r.P50, r.P95, r.Min, r.Max, r.Note)
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
	P95     float64              `json:"p95Ms"`
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
		r.P95 = sorted[min(len(sorted)-1, int(math.Ceil(float64(len(sorted))*0.95))-1)]
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
	// The shape every microVM create asks for (-size, or -vcpus/-memory/-disk).
	params := func(sid, owner string) proto.CreateParams {
		p := proto.CreateParams{SandboxID: sid, Tier: tier, Size: size, Owner: owner}
		if tier == "microvm" {
			p.Size, p.VCPUs, p.MemoryMiB, p.DiskGiB = benchShape.Size, benchShape.VCPUs, benchShape.MemoryMiB, benchShape.DiskGiB
		}
		return p
	}
	var info proto.SandboxInfo
	if !benchKeep {
		host.ResetTemplates(tier)

		// Cold create: nothing prepared (no template snapshot): the first sandbox of a fresh host, or of a new vCPU
		// count with shared templates.
		sid := id("cold", 0)
		t, err := call(proto.MethodCreate, params(sid, ""), &info)
		if err != nil {
			return out, fmt.Errorf("cold create: %w", err)
		}
		created = append(created, sid)
		if err := exec(sid); err != nil {
			return out, err
		}
		out = append(out, summarise(tier, "create", "cold", "first sandbox with no template made ("+info.Source+")", []float64{t}, []map[string]float64{info.Timings}))
	}
	// A shared template is made in the background after the cold create: what the next creates restore.
	waitStart := time.Now()
	if err := host.WaitTemplate(ctx, tier, params("", "")); err != nil {
		return out, fmt.Errorf("template: %w", err)
	}
	fmt.Fprintf(os.Stderr, "template ready after %.1fs more\n", time.Since(waitStart).Seconds())

	// Create from the template snapshot: how every create after the first is made (hosts keep no warm pools).
	var samples []float64
	var steps []map[string]float64
	for i := 0; i < runs; i++ {
		sid := id("snap", i)
		owner := ""
		if benchOwners == "new" {
			owner = fmt.Sprintf("bench-owner-%d-%d", time.Now().UnixNano(), i)
		}
		t, err := call(proto.MethodCreate, params(sid, owner), &info)
		if err != nil {
			return out, fmt.Errorf("create from template: %w", err)
		}
		created = append(created, sid)
		samples, steps = append(samples, t), append(steps, info.Timings)
		if err := exec(sid); err != nil {
			return out, err
		}
		if i == 0 && tier == "microvm" {
			// What the guest sees: its vCPUs, memory and disk, as asked (the disk grows just after the create).
			time.Sleep(2 * time.Second)
			var res proto.ExecResult
			if _, err := call(proto.MethodExec, proto.ExecParams{SandboxID: sid, Command: "echo vcpus=$(nproc) $(grep MemTotal /proc/meminfo | tr -s ' ') disk=$(df -BG --output=size /disk | tail -1 | tr -d ' ')"}, &res); err == nil {
				fmt.Fprintf(os.Stderr, "guest shape: %s", res.Stdout)
			}
		}
	}
	out = append(out, summarise(tier, "create", "snapshot", "restores the template snapshot", samples, steps))
	if benchOnly == "create" {
		return out, nil
	}

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

// bench's -only, -keep-templates and -owners, and the microVM shape it creates.
var (
	benchOnly   string
	benchKeep   bool
	benchOwners string
	benchShape  proto.CreateParams
)
