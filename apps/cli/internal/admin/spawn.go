package admin

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
)

// Ran is what a child process gives back: its exit code, and its stdout when it was captured.
type Ran struct {
	Code   int
	Stdout string
}

// SpawnOptions say how a child runs: Input (when set) goes to its stdin, else it reads ours; Capture keeps its stdout,
// else it writes to ours. Its stderr is always ours.
type SpawnOptions struct {
	Input   *string
	Capture bool
}

// Spawn runs a program and waits for it. An error is that it couldn't run at all (exec.ErrNotFound when it isn't
// installed); a program that ran and failed answers its exit code.
type Spawn func(ctx context.Context, command string, args []string, o SpawnOptions) (Ran, error)

// System is what kantel-admin runs and checks on the machine: child processes, the OS (runtime.GOOS's name, such as
// linux) and whether this process is root. Tests give their own.
type System struct {
	Spawn    Spawn
	Platform string
	IsRoot   bool
}

// ThisMachine is the machine kantel-admin runs on.
func ThisMachine() System {
	return System{Spawn: spawnProcess, Platform: runtime.GOOS, IsRoot: os.Geteuid() == 0}
}

// spawnError is a program that couldn't be run.
type spawnError struct {
	command string
	err     error
}

func (e *spawnError) Error() string { return "couldn't run " + e.command + ": " + e.err.Error() }
func (e *spawnError) Unwrap() error { return e.err }

func spawnProcess(ctx context.Context, command string, args []string, o SpawnOptions) (Ran, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if o.Input != nil {
		cmd.Stdin = strings.NewReader(*o.Input)
	}
	var out bytes.Buffer
	if o.Capture {
		cmd.Stdout = &out
	}
	err := cmd.Run()
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		return Ran{Code: 0, Stdout: out.String()}, nil
	case errors.As(err, &exitErr):
		code := exitErr.ExitCode()
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			// Killed by a signal: 128 and its number, as a shell says.
			code = 128 + int(status.Signal())
		} else if code < 0 {
			code = 1
		}
		return Ran{Code: code, Stdout: out.String()}, nil
	}
	return Ran{}, &spawnError{command, err}
}
