//go:build vmtest

// Real-VM manifest mount test: a Firecracker sandbox mounting a manifest of files the test wrote to an S3-compatible
// store (MinIO), with credentials that expire. It checks the guest's view (exactly the manifest's files, read-only),
// that the first read of part of a large file fetches only that part, that a changed object fails as stale, that
// expired credentials fail a read until refreshed, that the credentials never reach the guest, and that another
// account's source never reads this one's cached bytes. apps/host/test/mounts.sh runs it beside TestBucketMounts.
package agent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/bucket"
	"github.com/lleverage-ai/kantel/apps/host/internal/mounts"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// cacheFiles counts the chunks in the host's mount cache, and their bytes.
func cacheFiles(t *testing.T, dir string) (n int, bytes int64) {
	t.Helper()
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if info, err := d.Info(); err == nil {
				n++
				bytes += info.Size()
			}
		}
		return nil
	})
	return n, bytes
}

func TestManifestMounts(t *testing.T) {
	images := os.Getenv("KANTEL_VMTEST_IMAGES")
	firecracker := os.Getenv("KANTEL_VMTEST_FIRECRACKER")
	endpoint := os.Getenv("KANTEL_VMTEST_S3")
	key, secret := os.Getenv("KANTEL_VMTEST_S3_KEY"), os.Getenv("KANTEL_VMTEST_S3_SECRET")
	if images == "" || firecracker == "" || endpoint == "" || os.Geteuid() != 0 {
		t.Skip("needs root, KANTEL_VMTEST_IMAGES, KANTEL_VMTEST_FIRECRACKER and KANTEL_VMTEST_S3")
	}
	ctx := context.Background()
	const bucketName = "vmtest-manifest"
	store, err := bucket.NewClient(bucket.Source{Provider: "s3", Bucket: bucketName, Endpoint: endpoint,
		Credentials: bucket.Credentials{AccessKeyID: key, SecretAccessKey: secret}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.MakeBucket(ctx); err != nil {
		t.Fatal(err)
	}
	put := func(k string, data []byte) string {
		t.Helper()
		if err := store.Put(ctx, k, data); err != nil {
			t.Fatal(err)
		}
		objs, _, err := store.List(ctx, k, 0)
		if err != nil || len(objs) != 1 {
			t.Fatalf("listing %s: %v %v", k, objs, err)
		}
		return objs[0].ETag
	}
	large := make([]byte, 64<<20)
	_, _ = rand.Read(large)
	files := map[string]string{
		"project/README.md":       "# A project\n",
		"project/src/main.py":     "print('hello from the manifest')\n",
		"project/src/changing.py": "version = 1\n",
		"skills/hello/SKILL.md":   "# hello\nSays hello.\n",
		"skills/hello/run.sh":     "#!/bin/sh\necho hello from a skill\n",
		"project/expiry-a.txt":    "a\n",
		"project/expiry-b.txt":    "b\n",
	}
	var entries []mounts.ManifestFileEntry
	for i, p := range sortedKeys(files) {
		k := fmt.Sprintf("blobs/%02d", i)
		entries = append(entries, mounts.ManifestFileEntry{Path: p, Key: k, Size: int64(len(files[p])), ETag: put(k, []byte(files[p]))})
	}
	entries = append(entries,
		mounts.ManifestFileEntry{Path: "project/data/large.bin", Key: "blobs/large", Size: int64(len(large)), ETag: put("blobs/large", large)},
		mounts.ManifestFileEntry{Path: "project/empty-dir", Dir: true},
	)
	// In the bucket, and in no manifest: what another user of the account may see, but not this sandbox.
	put("blobs/hidden", []byte("another user's file\n"))
	raw, _ := json.Marshal(mounts.ManifestFile{Version: mounts.ManifestFormat, Entries: entries})
	sum := sha256.Sum256(raw)
	digest := "sha256:" + hex.EncodeToString(sum[:])
	put("manifests/session-1.json", raw)

	u, _ := url.Parse(endpoint)
	storeIP, err := netip.ParseAddr(u.Hostname())
	if err != nil {
		t.Fatalf("KANTEL_VMTEST_S3 needs an IP: %v", err)
	}
	root := t.TempDir()
	cfg := Config{
		Root: root, Kernel: filepath.Join(images, "vmlinux-x86_64"), SandboxImage: filepath.Join(images, "sandbox-amd64.ext4"),
		Firecracker: firecracker, Tiers: []string{"microvm"}, Egress: "open",
		EgressAllowCIDRs: []string{netip.PrefixFrom(storeIP, 32).String()},
	}
	cfg.Defaults()
	h, err := New(cfg, "vmtest", slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	// Kantel's side: two accounts' bucket sources, the same store and key, each with credentials that expire.
	var mu sync.Mutex
	expires := map[string]time.Time{"bks_acct_a": time.Now().Add(time.Hour), "bks_acct_b": time.Now().Add(time.Hour)}
	h.callKantel = func(_ context.Context, method string, params any) (json.RawMessage, error) {
		if method != proto.MethodBucketResolve {
			return nil, fmt.Errorf("unexpected %s", method)
		}
		p := params.(proto.BucketResolveParams)
		mu.Lock()
		exp, ok := expires[p.SourceID]
		mu.Unlock()
		if !ok {
			return nil, &proto.Error{Code: proto.ErrNotFound, Message: "no such bucket source"}
		}
		return json.Marshal(proto.BucketSource{ID: p.SourceID, Provider: "s3", Bucket: bucketName, Endpoint: endpoint,
			Credentials: &proto.BucketCredentials{AccessKeyID: key, SecretAccessKey: secret, ExpiresAt: exp.UnixMilli()}})
	}
	if facts := h.Facts(); !strings.Contains(strings.Join(facts.Features, ","), proto.FeatureManifestMounts) {
		t.Fatalf("no %s feature: %v", proto.FeatureManifestMounts, facts.Features)
	}
	create := func(id, source string) proto.SandboxInfo {
		t.Helper()
		mount := proto.Mount{Path: "/mnt/files", Kind: proto.MountManifest, BucketSourceID: source, ManifestKey: "manifests/session-1.json", Digest: digest}
		info := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: id, Tier: "microvm", Mounts: []proto.Mount{mount}})
		t.Cleanup(func() {
			_, _ = h.Call(context.Background(), proto.MethodDelete, json.RawMessage(fmt.Sprintf(`{"sandboxId":%q}`, id)), nil)
		})
		if len(info.Mounts) != 1 || info.Mounts[0].State != proto.MountReady {
			t.Fatalf("%s: mount not ready: %+v", id, info.Mounts)
		}
		t.Logf("%s: mount %+v", id, info.Mounts[0])
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
	cacheDir := filepath.Join(root, "mount-cache")

	create("sbx_man_a", "bks_acct_a")
	// Exactly the manifest's files and directories.
	got := strings.Fields(sh("sbx_man_a", "cd /mnt/files && find . -mindepth 1 | sort"))
	want := []string{"./project", "./project/README.md", "./project/data", "./project/data/large.bin", "./project/empty-dir",
		"./project/expiry-a.txt", "./project/expiry-b.txt", "./project/src", "./project/src/changing.py", "./project/src/main.py",
		"./skills", "./skills/hello", "./skills/hello/SKILL.md", "./skills/hello/run.sh"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("find:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if got := sh("sbx_man_a", "cat /mnt/files/project/src/main.py"); got != files["project/src/main.py"] {
		t.Errorf("cat main.py: %q", got)
	}
	if got := sh("sbx_man_a", "sh /mnt/files/skills/hello/run.sh"); got != "hello from a skill\n" {
		t.Errorf("run.sh: %q", got)
	}
	if got := sh("sbx_man_a", "stat -c %s /mnt/files/project/data/large.bin"); strings.TrimSpace(got) != fmt.Sprint(len(large)) {
		t.Errorf("large.bin's size: %q", got)
	}
	for _, w := range []string{"touch /mnt/files/new", "echo x > /mnt/files/project/README.md", "rm /mnt/files/project/README.md", "mkdir /mnt/files/d"} {
		if res := run(t, h, "sbx_man_a", w); res.ExitCode == 0 || !strings.Contains(res.Stderr, "Read-only file system") {
			t.Errorf("%q: exit %d, %q (want EROFS)", w, res.ExitCode, res.Stderr)
		}
	}
	if res := run(t, h, "sbx_man_a", fmt.Sprintf("grep -rlsF %q /run /etc /proc/self/environ /proc/1/environ /proc/mounts /home 2>/dev/null; true", secret)); strings.TrimSpace(res.Stdout) != "" {
		t.Errorf("the secret key is in the guest: %s", res.Stdout)
	}

	// The first read of 4 KiB of a 64 MiB file: one chunk of it in the host's cache, not the file.
	chunks, bytesBefore := cacheFiles(t, cacheDir)
	sh("sbx_man_a", "head -c 4096 /mnt/files/project/data/large.bin > /dev/null")
	chunksAfter, bytesAfter := cacheFiles(t, cacheDir)
	t.Logf("the first 4 KiB of a 64 MiB file: %d chunk(s), %d bytes into the host's cache", chunksAfter-chunks, bytesAfter-bytesBefore)
	if bytesAfter-bytesBefore > mounts.ChunkSize {
		t.Errorf("4 KiB of large.bin put %d bytes in the cache (want at most one %d-byte chunk)", bytesAfter-bytesBefore, mounts.ChunkSize)
	}
	if got := sh("sbx_man_a", "sha256sum < /mnt/files/project/data/large.bin"); !strings.HasPrefix(got, sha256hex(large)) {
		t.Errorf("large.bin's checksum: %q", got)
	}

	// An object changed since the manifest was written: never its new bytes under the old entry.
	put("blobs/"+fmt.Sprintf("%02d", indexOf(sortedKeys(files), "project/src/changing.py")), []byte("version = 2, not in the manifest\n"))
	if res := run(t, h, "sbx_man_a", "cat /mnt/files/project/src/changing.py"); res.ExitCode == 0 || !strings.Contains(res.Stderr, "Stale file handle") {
		t.Errorf("a changed object: exit %d, %q %q (want ESTALE)", res.ExitCode, res.Stdout, res.Stderr)
	} else {
		t.Logf("a changed object -> %s", strings.TrimSpace(res.Stderr))
	}

	// Credentials that lapse. A2's are good for 65 s when it mounts, so within a few seconds they are within the
	// host's minute of expiry and it asks Kantel again before each read; Kantel has only expired ones (the account
	// didn't refresh them): the read fails with EIO, and no request is made with them.
	mu.Lock()
	expires["bks_acct_a"] = time.Now().Add(65 * time.Second)
	mu.Unlock()
	create("sbx_man_a2", "bks_acct_a")
	mu.Lock()
	expires["bks_acct_a"] = time.Now().Add(-time.Second)
	mu.Unlock()
	time.Sleep(6 * time.Second)
	if res := run(t, h, "sbx_man_a2", "cat /mnt/files/project/expiry-a.txt"); res.ExitCode == 0 || !strings.Contains(res.Stderr, "Input/output error") {
		t.Errorf("expired credentials: exit %d, %q %q (want EIO)", res.ExitCode, res.Stdout, res.Stderr)
	} else {
		t.Logf("expired credentials -> %s", strings.TrimSpace(res.Stderr))
	}
	// Refreshed (Kantel has new ones): after the host's few seconds' backoff on expired credentials, a read asks
	// again and works.
	mu.Lock()
	expires["bks_acct_a"] = time.Now().Add(time.Hour)
	mu.Unlock()
	time.Sleep(6 * time.Second)
	if got := sh("sbx_man_a2", "cat /mnt/files/project/expiry-a.txt"); got != files["project/expiry-a.txt"] {
		t.Errorf("refreshed: %q", got)
	}

	// Another account's source, the same store, key and object: its own fetch, never this account's cached bytes.
	create("sbx_man_b", "bks_acct_b")
	chunks, _ = cacheFiles(t, cacheDir)
	sh("sbx_man_b", "cat /mnt/files/project/README.md > /dev/null")
	if after, _ := cacheFiles(t, cacheDir); after != chunks+1 {
		t.Errorf("another account's read of a cached file: %d new chunks (want 1, its own)", after-chunks)
	}
	// The same account's other sandbox, a file the first one read: from the cache.
	chunks, _ = cacheFiles(t, cacheDir)
	sh("sbx_man_a2", "cat /mnt/files/project/src/main.py > /dev/null")
	if after, _ := cacheFiles(t, cacheDir); after != chunks {
		t.Errorf("the same account's read of a cached file: %d new chunks (want none)", after-chunks)
	}

	// A stop and a resume keep the mount.
	keep := true
	vmCall[proto.SandboxInfo](t, h, proto.MethodStop, proto.StopParams{SandboxID: "sbx_man_a", Memory: &keep})
	resumed := vmCall[proto.SandboxInfo](t, h, proto.MethodResume, proto.SandboxRef{SandboxID: "sbx_man_a"})
	if len(resumed.Mounts) != 1 || resumed.Mounts[0].State != proto.MountReady {
		t.Errorf("after resume: %+v", resumed.Mounts)
	}
	if got := sh("sbx_man_a", "cat /mnt/files/skills/hello/SKILL.md"); got != files["skills/hello/SKILL.md"] {
		t.Errorf("after resume: %q", got)
	}
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func indexOf(xs []string, x string) int {
	for i, v := range xs {
		if v == x {
			return i
		}
	}
	return -1
}

func sha256hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
