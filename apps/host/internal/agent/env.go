package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
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

// currentEnv is the env a sandbox.env applies: the sandbox's as Kantel has it now (env.fetch), asked under the
// sandbox's lifecycle lock, so of two notifications however they land, the later applied is the newer env. Only a
// Kantel from before env.fetch (ErrUnsupported) leaves the notification's own env: any other failure, a lost link
// included, applies nothing, so an older notification can never put its env back.
func (h *Host) currentEnv(ctx context.Context, p proto.EnvParams) (map[string]string, error) {
	fetch := h.envFetch
	if fetch == nil {
		fetch = func(ctx context.Context, sandboxID string) (map[string]string, error) {
			raw, err := h.kantelCall(ctx, proto.MethodEnvFetch, proto.SandboxRef{SandboxID: sandboxID})
			if err != nil {
				return nil, err
			}
			var answer proto.EnvAnswer
			if err := json.Unmarshal(raw, &answer); err != nil {
				return nil, errors.New("env.fetch answered something that isn't an env")
			}
			return answer.Env, nil
		}
	}
	env, err := fetch(ctx, p.SandboxID)
	var perr *proto.Error
	if errors.As(err, &perr) && perr.Code == proto.ErrUnsupported {
		return p.Env, nil
	}
	return env, err
}

// setEnv is sandbox.env: the sandbox's whole env replaced where its tier keeps it, and for a running microVM its
// guest's env file rewritten, so new shells, terminals, ssh sessions and commands see it. A stopped sandbox gets it
// with its identity when it next boots. The caller holds the sandbox's lifecycle lock.
func (h *Host) setEnv(ctx context.Context, t Tier, tier string, p proto.EnvParams) error {
	s, ok := t.(envSetter)
	if !ok {
		return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s sandboxes don't change their env", tier)}
	}
	env, err := h.currentEnv(ctx, p)
	if err != nil {
		return err
	}
	p.Env = env
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
	// Its own PATH, not the sandbox's (which its env may have changed), so the system's tools are the ones run.
	envPath         = `PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH; `
	envWriteScript  = envPath + `set -e; mkdir -p "$(dirname ` + guest.EnvFile + `)"; cat > ` + guest.EnvFile + `.new; chmod 644 ` + guest.EnvFile + `.new; mv -f ` + guest.EnvFile + `.new ` + guest.EnvFile
	envRemoveScript = envPath + `rm -f ` + guest.EnvFile
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
