package guest

import (
	"context"
	"os"
	"strings"
	"testing"
)

// The test binary stands in for the agent's: started as exec-command, it does what kantel-guest does.
func TestMain(m *testing.M) {
	if len(os.Args) >= 2 && os.Args[1] == ExecCommandVerb {
		ExecCommandMain(os.Args[2:])
	}
	os.Exit(m.Run())
}

func TestCommandsDontInheritTheAgentsOOMScore(t *testing.T) {
	// The agent's own -1000 can't be set without root, and an unprivileged process may only raise its score, so this
	// checks the plumbing (the command runs through exec-command, as given, at 0); a microVM checks the -1000.
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// The command as the agent builds it, run as this test's user (taking on another needs root).
	dir := t.TempDir()
	run := func(s *Server, req ExecRequest) (string, error) {
		req.Cwd = dir
		cmd, err := s.buildCommand(context.Background(), &req)
		if err != nil {
			return "", err
		}
		cmd.SysProcAttr.Credential = nil
		out, err := cmd.Output()
		return strings.TrimSpace(string(out)), err
	}
	// 0. A runner that already runs above 0 and may not lower its own score (no CAP_SYS_RESOURCE) stays where it is.
	own := "0"
	if raw, err := os.ReadFile("/proc/self/oom_score_adj"); err == nil {
		own = strings.TrimSpace(string(raw))
	}
	if out, err := run(&Server{Trampoline: self}, ExecRequest{Command: "cat /proc/self/oom_score_adj"}); err != nil ||
		(out != "0" && out != own) {
		t.Fatalf("a command's OOM score adjustment: %q, %v; want 0 (or this test's own %s)", out, err, own)
	}
	// argv arrives as given, and a missing program still fails.
	out, err := run(&Server{Trampoline: self}, ExecRequest{Argv: []string{"sh", "-c", "echo $0 $1", "first", "second"}})
	if err != nil || out != "first second" {
		t.Fatalf("argv: %q, %v", out, err)
	}
	if _, err := run(&Server{Trampoline: self}, ExecRequest{Argv: []string{"no-such-program-here"}}); err == nil {
		t.Fatal("a missing program ran")
	}
}

func TestSetArgv0(t *testing.T) {
	self, _ := os.Executable()
	cmd, err := (&Server{Trampoline: self}).buildCommand(context.Background(), &ExecRequest{Argv: []string{"/bin/sh", "-l"}})
	if err != nil {
		t.Skip(err)
	}
	setArgv0(cmd, "-sh")
	if cmd.Path != self || cmd.Args[1] != ExecCommandVerb || cmd.Args[2] != "/bin/sh" || cmd.Args[3] != "-sh" {
		t.Fatalf("%s %q", cmd.Path, cmd.Args)
	}
	plain, err := (&Server{}).buildCommand(context.Background(), &ExecRequest{Argv: []string{"/bin/sh", "-l"}})
	if err != nil {
		t.Fatal(err)
	}
	setArgv0(plain, "-sh")
	if plain.Args[0] != "-sh" {
		t.Fatalf("%q", plain.Args)
	}
}
