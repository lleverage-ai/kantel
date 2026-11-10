package agent

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// envSetter is a tier that keeps each sandbox's env (microvm and isolate, in their meta.json): what it boots with,
// what its commands take, and what a fork with none of its own inherits.
type envSetter interface {
	SetEnv(id string, env map[string]string) error
}

// setEnv is sandbox.env: the sandbox's whole env replaced where its tier keeps it, and for a running microVM its
// guest's env file rewritten, so new shells, terminals, ssh sessions and commands see it. A stopped sandbox gets it
// with its identity when it next boots. The caller holds the sandbox's lifecycle lock.
func (h *Host) setEnv(ctx context.Context, t Tier, tier string, p proto.EnvParams) error {
	s, ok := t.(envSetter)
	if !ok {
		return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s sandboxes don't change their env", tier)}
	}
	if err := s.SetEnv(p.SandboxID, p.Env); err != nil {
		return err
	}
	if tier != microvm.Tier {
		// An isolate reads its env from the host's record with each command.
		return nil
	}
	info, err := t.Get(p.SandboxID)
	if err != nil || info.State != proto.StateRunning {
		return nil
	}
	if err := writeGuestEnv(ctx, t, p.SandboxID, p.Env); err != nil {
		return fmt.Errorf("the sandbox's env changed, but its running machine's %s couldn't be rewritten (it is on its next boot): %w", guest.EnvFile, err)
	}
	return nil
}

// Scripts that rewrite a running guest's env file, as the guest agent's writeEnv does at boot. The content comes on
// stdin, never in the script, so no value is ever parsed by the shell; it replaces the file in one rename, so a shell
// starting meanwhile reads the old file or the new one, never half of it.
const (
	envWriteScript  = `set -e; mkdir -p "$(dirname ` + guest.EnvFile + `)"; cat > ` + guest.EnvFile + `.new; chmod 644 ` + guest.EnvFile + `.new; mv -f ` + guest.EnvFile + `.new ` + guest.EnvFile
	envRemoveScript = `rm -f ` + guest.EnvFile
)

// writeGuestEnv makes a running microVM's env file hold exactly env (none for an empty one), as root.
func writeGuestEnv(ctx context.Context, t Tier, sandboxID string, env map[string]string) error {
	p := proto.ExecParams{SandboxID: sandboxID, Argv: []string{"/bin/sh", "-c", envRemoveScript}, User: "root", TimeoutMs: 30_000}
	if len(env) > 0 {
		p.Argv[2] = envWriteScript
		p.Stdin = base64.StdEncoding.EncodeToString([]byte(guest.EnvFileContent(env)))
	}
	res, err := t.Exec(ctx, p, nil)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("exited %d: %s", res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return nil
}
