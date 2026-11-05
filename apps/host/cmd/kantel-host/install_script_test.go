package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// install.sh's --dry-run and --check, against a release in a directory (curl reads file:// URLs) holding a stand-in
// kantel-host that records how it was run, with an `id` that says root. Neither installs anything.
func TestInstallScriptDryRunAndCheck(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("install.sh runs on Linux")
	}
	for _, tool := range []string{"sh", "curl", "awk"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip("needs " + tool)
		}
	}
	script, err := filepath.Abs(filepath.Join("..", "..", "install.sh"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	release, shim, bin := filepath.Join(dir, "release"), filepath.Join(dir, "shim"), filepath.Join(dir, "bin")
	for _, d := range []string{release, shim, bin} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	asset := "kantel-host-linux-" + archName()
	calls := filepath.Join(dir, "calls")
	stand := "#!/bin/sh\n" +
		"[ \"$1\" = version ] && { echo fake; exit 0; }\n" +
		"echo \"$*\" >>" + calls + "\n" +
		"[ \"$1\" = doctor ] && { echo 'FAIL    kvm'; exit 3; }\n" +
		"echo '==> the plan'\n"
	if err := os.WriteFile(filepath.Join(release, asset), []byte(stand), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(stand))
	digest := hex.EncodeToString(sum[:])
	if err := os.WriteFile(filepath.Join(release, "SHA256SUMS"), []byte(digest+"  "+asset+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shim, "id"), []byte("#!/bin/sh\necho 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(root bool, args ...string) (string, int) {
		t.Helper()
		_ = os.Remove(calls)
		cmd := exec.Command("sh", append([]string{script}, args...)...)
		path := os.Getenv("PATH")
		if root {
			path = shim + ":" + path
		}
		cmd.Env = append(os.Environ(), "PATH="+path, "KANTEL_RELEASE_URL=file://"+release, "KANTEL_BIN_DIR="+bin)
		out, err := cmd.CombinedOutput()
		code := 0
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else if err != nil {
			t.Fatal(err)
		}
		return string(out), code
	}
	recorded := func() string {
		raw, _ := os.ReadFile(calls)
		return strings.TrimSpace(string(raw))
	}
	nothingInstalled := func(what string) {
		t.Helper()
		if entries, _ := os.ReadDir(bin); len(entries) != 0 {
			t.Errorf("%s put %d files in the bin directory", what, len(entries))
		}
	}

	// --dry-run, anywhere in the options: the binary's digest, then its install --dry-run with every option.
	out, code := run(true, "--url", "https://kantel.invalid", "--dry-run", "--token", "kth_x")
	if code != 0 || !strings.Contains(out, "get    file://"+release+"/"+asset+" (sha256 "+digest+", from file://"+release+"/SHA256SUMS)") || !strings.Contains(out, "==> the plan") {
		t.Errorf("--dry-run: exit %d\n%s", code, out)
	}
	if got := recorded(); got != "plan --url https://kantel.invalid --dry-run --token kth_x" {
		t.Errorf("--dry-run ran: %q", got)
	}
	nothingInstalled("--dry-run")
	// Another way Go's flags spell true: still a dry run, with nothing installed first.
	if out, code := run(true, "--url", "https://kantel.invalid", "--token", "kth_x", "--dry-run=1"); code != 0 || recorded() != "plan --url https://kantel.invalid --token kth_x --dry-run=1" {
		t.Errorf("--dry-run=1: exit %d, ran %q\n%s", code, recorded(), out)
	}
	nothingInstalled("--dry-run=1")
	// An option that takes "--dry-run" as its value: still plan, which is only ever a dry run.
	if out, code := run(true, "--name", "--dry-run", "--url", "https://kantel.invalid", "--token", "kth_x"); code != 0 || recorded() != "plan --name --dry-run --url https://kantel.invalid --token kth_x" {
		t.Errorf("--name --dry-run: exit %d, ran %q\n%s", code, recorded(), out)
	}
	nothingInstalled("--name --dry-run")

	// --no-join --dry-run: says where the binary would go, and runs nothing.
	out, code = run(false, "--no-join", "--dry-run")
	if code != 0 || !strings.Contains(out, "write  "+bin+"/kantel-host (mode 0755)") || recorded() != "" {
		t.Errorf("--no-join --dry-run: exit %d, ran %q\n%s", code, recorded(), out)
	}
	nothingInstalled("--no-join --dry-run")

	// --check: doctor, with the options it takes, and its exit status.
	out, code = run(true, "--check", "--url", "https://kantel.invalid", "--token", "kth_x", "--isolate-runtime", "native", "--root=/srv/kh")
	if code != 3 || !strings.Contains(out, "FAIL    kvm") {
		t.Errorf("--check: exit %d\n%s", code, out)
	}
	if got := recorded(); got != "doctor --isolate-runtime native --root=/srv/kh" {
		t.Errorf("--check ran: %q", got)
	}
	nothingInstalled("--check")

	// Both need root, as the install does.
	if os.Geteuid() == 0 {
		return
	}
	for _, args := range [][]string{{"--check"}, {"--dry-run", "--url", "https://kantel.invalid", "--token", "kth_x"}} {
		if out, code := run(false, args...); code == 0 || !strings.Contains(out, "needs root") || recorded() != "" {
			t.Errorf("%v as a user: exit %d, ran %q\n%s", args, code, recorded(), out)
		}
	}
}
