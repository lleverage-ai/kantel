//go:build vmtest

// Real-VM bucket mount tests: two Firecracker sandboxes mounting one prefix of an S3-compatible store (MinIO), read
// through the host's shared cache. They check the guest's view (ls -R, cat, EROFS), a refresh after the bucket
// changes, that the bucket source's credentials never reach the guest, and measure first reads cold (the store) and
// host-cached (a second sandbox on the same host), and the list calls a mount and a refresh cost.
//
//	KANTEL_VMTEST_IMAGES=/images KANTEL_VMTEST_FIRECRACKER=/opt/kantel/firecracker \
//	KANTEL_VMTEST_S3=http://172.18.0.2:9000 KANTEL_VMTEST_S3_KEY=… KANTEL_VMTEST_S3_SECRET=… \
//	  go test -tags vmtest -run BucketMounts -v ./internal/agent/
//
// apps/host/test/mounts.sh runs them in a privileged container beside a MinIO of their own.
package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/bucket"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func median(xs []float64) float64 {
	s := append([]float64{}, xs...)
	sort.Float64s(s)
	if len(s) == 0 {
		return 0
	}
	if len(s)%2 == 1 {
		return s[len(s)/2]
	}
	return (s[len(s)/2-1] + s[len(s)/2]) / 2
}

func TestBucketMounts(t *testing.T) {
	images := os.Getenv("KANTEL_VMTEST_IMAGES")
	firecracker := os.Getenv("KANTEL_VMTEST_FIRECRACKER")
	endpoint := os.Getenv("KANTEL_VMTEST_S3")
	key, secret := os.Getenv("KANTEL_VMTEST_S3_KEY"), os.Getenv("KANTEL_VMTEST_S3_SECRET")
	if images == "" || firecracker == "" || endpoint == "" || os.Geteuid() != 0 {
		t.Skip("needs root, KANTEL_VMTEST_IMAGES, KANTEL_VMTEST_FIRECRACKER and KANTEL_VMTEST_S3")
	}
	ctx := context.Background()
	const bucketName = "vmtest"
	store, err := bucket.NewClient(bucket.Source{Provider: "s3", Bucket: bucketName, Endpoint: endpoint,
		Credentials: bucket.Credentials{AccessKeyID: key, SecretAccessKey: secret}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.MakeBucket(ctx); err != nil {
		t.Fatal(err)
	}
	put := func(k string, data []byte) {
		t.Helper()
		if err := store.Put(ctx, k, data); err != nil {
			t.Fatal(err)
		}
	}
	// The mounted prefix, and something beside it that must not show.
	put("org/42/skills/hello/SKILL.md", []byte("# hello\nSays hello.\n"))
	put("org/42/skills/hello/run.sh", []byte("#!/bin/sh\necho hello from the bucket\n"))
	put("org/42/notes.txt", []byte("version 1\n"))
	put("org/42/empty", nil)
	put("org/42/untouched.txt", []byte("original\n"))
	put("org/43/secret.txt", []byte("another org's\n"))
	sizes := []int{64 << 10, 1 << 20, 16 << 20, 64 << 20, 256 << 20}
	const copies = 5
	for _, n := range sizes {
		data := make([]byte, n)
		_, _ = rand.Read(data)
		for c := range copies {
			put(fmt.Sprintf("org/42/blobs/%d-%d.bin", n, c), data)
		}
	}

	u, _ := url.Parse(endpoint)
	storeIP, err := netip.ParseAddr(u.Hostname())
	if err != nil {
		t.Fatalf("KANTEL_VMTEST_S3 needs an IP: %v", err)
	}
	root := t.TempDir()
	cfg := Config{
		Root: root, Kernel: filepath.Join(images, "vmlinux-x86_64"), SandboxImage: filepath.Join(images, "sandbox-amd64.ext4"),
		Firecracker: firecracker, Tiers: []string{"microvm"}, Egress: "open",
		// The store is on a private address: the host reaches it only because the operator allows it.
		EgressAllowCIDRs: []string{netip.PrefixFrom(storeIP, 32).String()},
	}
	cfg.Defaults()
	h, err := New(cfg, "vmtest", slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	fetches := 0
	h.callKantel = func(_ context.Context, method string, params any) (json.RawMessage, error) {
		if method != proto.MethodBucketResolve {
			return nil, fmt.Errorf("unexpected %s", method)
		}
		p := params.(proto.BucketResolveParams)
		if p.SourceID != "bks_vmtest" {
			return nil, &proto.Error{Code: proto.ErrNotFound, Message: "no such bucket source"}
		}
		fetches++
		return json.Marshal(proto.BucketSource{ID: p.SourceID, Provider: "s3", Bucket: bucketName, Endpoint: endpoint,
			Credentials: &proto.BucketCredentials{AccessKeyID: key, SecretAccessKey: secret}})
	}
	if facts := h.Facts(); !strings.Contains(strings.Join(facts.Features, ","), proto.FeatureBucketMounts) {
		t.Fatalf("no %s feature: %v", proto.FeatureBucketMounts, facts.Features)
	}

	ttl := 0
	mount := proto.Mount{Path: "/mnt/org", Kind: proto.MountBucket, BucketSourceID: "bks_vmtest", Prefix: "org/42/", RefreshTTLSeconds: &ttl}
	create := func(id string) proto.SandboxInfo {
		start := time.Now()
		info := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: id, Tier: "microvm", Mounts: []proto.Mount{mount}})
		t.Cleanup(func() {
			_, _ = h.Call(context.Background(), proto.MethodDelete, json.RawMessage(fmt.Sprintf(`{"sandboxId":%q}`, id)), nil)
		})
		t.Logf("%s created in %s; timings %v", id, time.Since(start).Round(time.Millisecond), info.Timings)
		return info
	}
	sh := func(id, command string) string {
		t.Helper()
		res := run(t, h, id, command)
		if res.ExitCode != 0 {
			t.Fatalf("%s: %q exited %d: %s %s", id, command, res.ExitCode, res.Stdout, res.Stderr)
		}
		return res.Stdout
	}

	a := create("sbx_mnt_a")
	if len(a.Mounts) != 1 || a.Mounts[0].State != proto.MountReady {
		t.Fatalf("mount not ready: %+v", a.Mounts)
	}
	t.Logf("A's mount: %+v (bucket.fetch calls %d)", a.Mounts[0], fetches)
	listsAtMount := a.Mounts[0].ListCalls

	tree := sh("sbx_mnt_a", "ls -R /mnt/org")
	t.Logf("ls -R /mnt/org:\n%s", tree)
	for _, want := range []string{"skills", "hello", "SKILL.md", "run.sh", "notes.txt", "empty", "blobs"} {
		if !strings.Contains(tree, want) {
			t.Errorf("ls -R has no %s", want)
		}
	}
	if strings.Contains(tree, "secret.txt") {
		t.Errorf("another prefix's object shows: %s", tree)
	}
	if got := sh("sbx_mnt_a", "cat /mnt/org/skills/hello/SKILL.md"); got != "# hello\nSays hello.\n" {
		t.Errorf("cat: %q", got)
	}
	if got := sh("sbx_mnt_a", "sh /mnt/org/skills/hello/run.sh"); got != "hello from the bucket\n" {
		t.Errorf("run: %q", got)
	}
	if got := sh("sbx_mnt_a", "wc -c < /mnt/org/empty"); strings.TrimSpace(got) != "0" {
		t.Errorf("empty object: %q", got)
	}
	// Writes of every kind fail with EROFS, as root too.
	for _, w := range []string{
		"touch /mnt/org/new", "echo x > /mnt/org/notes.txt", "rm /mnt/org/notes.txt", "mkdir /mnt/org/d",
		"mv /mnt/org/notes.txt /mnt/org/n2", "chmod 777 /mnt/org/notes.txt",
	} {
		res := run(t, h, "sbx_mnt_a", w)
		if res.ExitCode == 0 || !strings.Contains(res.Stderr, "Read-only file system") {
			t.Errorf("%q: exit %d, %q (want EROFS)", w, res.ExitCode, res.Stderr)
		} else {
			t.Logf("%-45s -> %s", w, strings.TrimSpace(res.Stderr))
		}
	}
	// The bucket source's credentials are nowhere in the guest: not its environment, its files or its mount table.
	if res := run(t, h, "sbx_mnt_a", fmt.Sprintf("grep -rlsF %q /run /etc /proc/self/environ /proc/1/environ /proc/mounts /home 2>/dev/null; true", secret)); strings.TrimSpace(res.Stdout) != "" {
		t.Errorf("the secret key is in the guest: %s", res.Stdout)
	}
	if mounts := sh("sbx_mnt_a", "grep /mnt/org /proc/mounts"); !strings.Contains(mounts, " ro,") {
		t.Errorf("not mounted read-only: %s", mounts)
	}

	// First reads: cold (A, from the store), then host-cached (B, a second sandbox on the same host).
	readMs := func(id, p string) (first, whole float64) {
		t.Helper()
		// Each object is read once per sandbox, so its guest's page cache never has it: every read reaches FUSE. Timed
		// inside one process, so starting it isn't: open and the first byte, then the rest in 1 MiB reads.
		out := sh(id, fmt.Sprintf(`python3 -c '
import os, sys, time
t0 = time.perf_counter_ns()
fd = os.open(sys.argv[1], os.O_RDONLY)
os.read(fd, 1)
t1 = time.perf_counter_ns()
while os.read(fd, 1 << 20):
    pass
t2 = time.perf_counter_ns()
print((t1 - t0) // 1000, (t2 - t1) // 1000)
' %s`, p))
		f := strings.Fields(out)
		x, _ := strconv.ParseFloat(f[0], 64)
		y, _ := strconv.ParseFloat(f[1], 64)
		return x / 1000, y / 1000
	}
	b := create("sbx_mnt_b")
	if len(b.Mounts) != 1 || b.Mounts[0].State != proto.MountReady {
		t.Fatalf("B's mount not ready: %+v", b.Mounts)
	}
	// The same reads of a file on the sandbox's own disk, for scale: what the tools and the timing cost by themselves.
	sh("sbx_mnt_a", "head -c 1048576 /dev/urandom > /tmp/local-1m && sync")
	var localFirst, localWhole []float64
	for range copies {
		f, w := readMs("sbx_mnt_a", "/tmp/local-1m")
		localFirst, localWhole = append(localFirst, f), append(localWhole, w)
	}
	t.Logf("a 1 MiB file on the sandbox's disk, page-cached: first byte %.1f ms, whole file %.1f ms", median(localFirst), median(localFirst)+median(localWhole))
	type row struct{ coldFirst, coldWhole, warmFirst, warmWhole []float64 }
	rows := map[int]*row{}
	for _, n := range sizes {
		r := &row{}
		rows[n] = r
		for c := range copies {
			p := fmt.Sprintf("/mnt/org/blobs/%d-%d.bin", n, c)
			f, w := readMs("sbx_mnt_a", p)
			r.coldFirst, r.coldWhole = append(r.coldFirst, f), append(r.coldWhole, w)
			f, w = readMs("sbx_mnt_b", p)
			r.warmFirst, r.warmWhole = append(r.warmFirst, f), append(r.warmWhole, w)
		}
	}
	var table bytes.Buffer
	fmt.Fprintf(&table, "| size | first byte cold (ms) | first byte host-cached (ms) | whole file cold (ms) | whole file host-cached (ms) | cold MB/s | cached MB/s |\n|---|---|---|---|---|---|---|\n")
	for _, n := range sizes {
		r := rows[n]
		mb := float64(n) / 1e6
		fmt.Fprintf(&table, "| %s | %.1f | %.1f | %.1f | %.1f | %.0f | %.0f |\n", human(n), median(r.coldFirst), median(r.warmFirst),
			median(r.coldFirst)+median(r.coldWhole), median(r.warmFirst)+median(r.warmWhole),
			mb/((median(r.coldFirst)+median(r.coldWhole))/1000), mb/((median(r.warmFirst)+median(r.warmWhole))/1000))
	}
	t.Logf("medians of %d (a different object per run for cold reads):\n%s", copies, table.String())

	// The bucket changes: one object rewritten, one added. A refresh shows both.
	// B reads notes.txt first, so the host has it cached; untouched.txt nobody reads.
	if got := sh("sbx_mnt_b", "cat /mnt/org/notes.txt"); got != "version 1\n" {
		t.Errorf("B's notes.txt: %q", got)
	}
	put("org/42/notes.txt", []byte("version 2, longer\n"))
	put("org/42/untouched.txt", []byte("rewritten\n"))
	put("org/42/added.txt", []byte("added later\n"))
	// Before a refresh, A still sees the manifest's version: notes.txt from the host's cache (B read it), and
	// untouched.txt, which no sandbox read and the store no longer has, fails with ESTALE rather than answer bytes
	// that aren't the size and ETag listed.
	if got := sh("sbx_mnt_a", "cat /mnt/org/notes.txt"); got != "version 1\n" {
		t.Errorf("before the refresh, notes.txt is %q (want the manifest's version 1, cached)", got)
	}
	if res := run(t, h, "sbx_mnt_a", "cat /mnt/org/untouched.txt"); res.ExitCode == 0 || !strings.Contains(res.Stderr, "Stale file handle") {
		t.Errorf("before the refresh, untouched.txt: %q %q (want ESTALE)", res.Stdout, res.Stderr)
	} else {
		t.Logf("before the refresh, a changed object never read -> %s", strings.TrimSpace(res.Stderr))
	}
	before := vmCall[proto.SandboxInfo](t, h, proto.MethodGet, proto.SandboxRef{SandboxID: "sbx_mnt_a"}).Mounts[0].ListCalls
	statuses := vmCall[[]proto.MountStatus](t, h, proto.MethodMountsRefresh, proto.MountsRefreshParams{SandboxID: "sbx_mnt_a"})
	if len(statuses) != 1 || statuses[0].State != proto.MountReady {
		t.Fatalf("refresh: %+v", statuses)
	}
	t.Logf("list calls: %d at mount, %d for one refresh (%d objects)", listsAtMount, statuses[0].ListCalls-before, statuses[0].Objects)
	if got := sh("sbx_mnt_a", "cat /mnt/org/notes.txt"); got != "version 2, longer\n" {
		t.Errorf("after the refresh, notes.txt is %q", got)
	}
	if got := sh("sbx_mnt_a", "cat /mnt/org/added.txt"); got != "added later\n" {
		t.Errorf("after the refresh, added.txt is %q", got)
	}
	if got := sh("sbx_mnt_a", "cat /mnt/org/untouched.txt"); got != "rewritten\n" {
		t.Errorf("after the refresh, untouched.txt is %q", got)
	}
	// B refreshes itself, from inside, through the mount's xattr.
	sh("sbx_mnt_b", `python3 -c 'import os; print(os.getxattr("/mnt/org", "user.kantel.refresh").decode())'`)
	if got := sh("sbx_mnt_b", "cat /mnt/org/added.txt"); got != "added later\n" {
		t.Errorf("after B's own refresh, added.txt is %q", got)
	}

	// A stop and a resume keep the mount.
	keep := true
	vmCall[proto.SandboxInfo](t, h, proto.MethodStop, proto.StopParams{SandboxID: "sbx_mnt_a", Memory: &keep})
	resumed := vmCall[proto.SandboxInfo](t, h, proto.MethodResume, proto.SandboxRef{SandboxID: "sbx_mnt_a"})
	if len(resumed.Mounts) != 1 || resumed.Mounts[0].State != proto.MountReady {
		t.Errorf("after resume: %+v", resumed.Mounts)
	}
	if got := sh("sbx_mnt_a", "cat /mnt/org/skills/hello/SKILL.md"); got != "# hello\nSays hello.\n" {
		t.Errorf("after resume, cat: %q", got)
	}
	// A cold stop and start mounts it again.
	cold := false
	vmCall[proto.SandboxInfo](t, h, proto.MethodStop, proto.StopParams{SandboxID: "sbx_mnt_a", Memory: &cold})
	started := vmCall[proto.SandboxInfo](t, h, proto.MethodResume, proto.SandboxRef{SandboxID: "sbx_mnt_a"})
	if len(started.Mounts) != 1 || started.Mounts[0].State != proto.MountReady {
		t.Errorf("after a cold start: %+v", started.Mounts)
	}
	if got := sh("sbx_mnt_a", "cat /mnt/org/added.txt"); got != "added later\n" {
		t.Errorf("after a cold start, cat: %q", got)
	}

	// A bucket source Kantel won't give: the mount fails, the sandbox runs without it.
	bad := mount
	bad.Path, bad.BucketSourceID = "/mnt/nope", "bks_missing"
	info := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_mnt_c", Tier: "microvm", Mounts: []proto.Mount{bad}})
	t.Cleanup(func() {
		_, _ = h.Call(context.Background(), proto.MethodDelete, json.RawMessage(`{"sandboxId":"sbx_mnt_c"}`), nil)
	})
	if info.State != proto.StateRunning || len(info.Mounts) != 1 || info.Mounts[0].State != proto.MountFailed || info.Mounts[0].Error == "" {
		t.Errorf("a missing bucket source: %s %+v", info.State, info.Mounts)
	} else {
		t.Logf("a missing bucket source: %s, mount %s: %s", info.State, info.Mounts[0].State, info.Mounts[0].Error)
	}

	// The host restarts while A runs: the new one adopts it and its guest keeps the mount; the mount is pending until
	// the host can resolve its source (connected to Kantel), then confirmed with the guest: ready.
	h.Close()
	h2, err := New(cfg, "vmtest", slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h2.Close)
	for _, id := range []string{"sbx_mnt_a", "sbx_mnt_b", "sbx_mnt_c"} {
		t.Cleanup(func() {
			_, _ = h2.Call(context.Background(), proto.MethodDelete, json.RawMessage(fmt.Sprintf(`{"sandboxId":%q}`, id)), nil)
		})
	}
	h2.callKantel = h.callKantel
	adopted := vmCall[proto.SandboxInfo](t, h2, proto.MethodGet, proto.SandboxRef{SandboxID: "sbx_mnt_a"})
	if adopted.State != proto.StateRunning || len(adopted.Mounts) != 1 || adopted.Mounts[0].State != proto.MountPending {
		t.Errorf("adopted, before the host connects: %s %+v", adopted.State, adopted.Mounts)
	}
	if res := run(t, h2, "sbx_mnt_a", "cat /mnt/org/notes.txt"); res.ExitCode != 0 {
		t.Errorf("adopted, the guest's mount: %d %s", res.ExitCode, res.Stderr)
	}
	reconciled, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	h2.reconcileMounts(reconciled)
	deadline := time.Now().Add(30 * time.Second)
	for {
		adopted = vmCall[proto.SandboxInfo](t, h2, proto.MethodGet, proto.SandboxRef{SandboxID: "sbx_mnt_a"})
		if len(adopted.Mounts) == 1 && adopted.Mounts[0].State == proto.MountReady {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("adopted, after the host connected: %+v", adopted.Mounts)
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Logf("adopted: mount %s, %d objects", adopted.Mounts[0].State, adopted.Mounts[0].Objects)
	if got := sh2(t, h2, "sbx_mnt_a", "cat /mnt/org/added.txt"); got != "added later\n" {
		t.Errorf("adopted, cat: %q", got)
	}
}

func sh2(t *testing.T, h *Host, id, command string) string {
	t.Helper()
	res := run(t, h, id, command)
	if res.ExitCode != 0 {
		t.Fatalf("%s: %q exited %d: %s %s", id, command, res.ExitCode, res.Stdout, res.Stderr)
	}
	return res.Stdout
}

func human(n int) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%d MiB", n>>20)
	default:
		return fmt.Sprintf("%d KiB", n>>10)
	}
}
