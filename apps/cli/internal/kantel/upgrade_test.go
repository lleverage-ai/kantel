package kantel

import (
	"encoding/json"
	"testing"
)

// Upgrading an isolate to a microVM (the upgrade part of packages/cli/test/cli.test.ts): kantel upgrade, kantel new
// --auto-upgrade and --auto-upgrade-from, and what kantel exec says of a command that needed a microVM.

func TestUpgradeSendsWhatWasAsked(t *testing.T) {
	microvm := func(call) any {
		return sandbox(map[string]any{"type": "microvm", "size": "large", "upgradedFrom": map[string]any{"type": "isolate", "at": 1}})
	}
	r := run(t, []string{"upgrade", "sbx_test1", "--size", "large", "--image", "ubuntu-26.04"},
		opts{routes: routes{"POST /v1/sandboxes/sbx_test1/upgrade": microvm}})
	eq(t, "exit", r.Code, 0)
	got, _ := json.Marshal(r.Calls[0].Body)
	eq(t, "body", string(got), `{"image":"ubuntu-26.04","size":"large","wait":true}`)
	if r.Calls[0].Key == "" {
		t.Error("no Idempotency-Key on upgrade")
	}
	contains(t, "out", r.Stdout, "Upgraded sbx_test1 (brisk-otter) to a microVM")
	contains(t, "out", r.Stdout, "/home/user/workspace (/workspace links there)")

	r = run(t, []string{"upgrade", "sbx_test1", "--vcpus", "8", "--memory", "16", "--disk", "60", "--no-wait"},
		opts{routes: routes{"POST /v1/sandboxes/sbx_test1/upgrade": microvm}})
	got, _ = json.Marshal(r.Calls[0].Body)
	eq(t, "shaped body", string(got), `{"resources":{"diskGb":60,"memoryMb":16384,"vcpus":8},"wait":false}`)

	r = run(t, []string{"upgrade", "sbx_test1", "--from", "monorepo-ci"},
		opts{routes: routes{"POST /v1/sandboxes/sbx_test1/upgrade": microvm}})
	eq(t, "exit", r.Code, 0)
	got, _ = json.Marshal(r.Calls[0].Body)
	eq(t, "from body", string(got), `{"from":"monorepo-ci","wait":true}`)

	for _, argv := range [][]string{
		{"upgrade", "sbx_test1", "--from", "monorepo-ci", "--disk", "60"},
		{"upgrade", "sbx_test1", "--vcpus", "2"},
		{"upgrade", "sbx_test1", "--size", "large", "--vcpus", "2", "--memory", "4"},
		{"upgrade", "sbx_test1", "--wait", "--no-wait"},
	} {
		r := run(t, argv, opts{})
		eq(t, "refused", r.Code, 2)
		eq(t, "calls", len(r.Calls), 0)
	}
}

func TestNewAutoUpgrade(t *testing.T) {
	made := routes{"POST /v1/sandboxes": func(call) any { return sandbox(map[string]any{"autoUpgrade": true}) }}
	r := run(t, []string{"new", "--auto-upgrade"}, opts{routes: made})
	eq(t, "exit", r.Code, 0)
	got, _ := json.Marshal(r.Calls[0].Body)
	eq(t, "body", string(got), `{"autoUpgrade":true,"wait":true}`)
	r = run(t, []string{"new", "--type", "microvm", "--auto-upgrade"}, opts{routes: made})
	eq(t, "microvm", r.Code, 2)
	eq(t, "calls", len(r.Calls), 0)

	// Naming what it upgrades into turns it on.
	r = run(t, []string{"new", "--auto-upgrade-from", "monorepo-ci"}, opts{routes: made})
	eq(t, "exit", r.Code, 0)
	got, _ = json.Marshal(r.Calls[0].Body)
	eq(t, "into body", string(got), `{"autoUpgrade":true,"autoUpgradeFrom":"monorepo-ci","wait":true}`)
	r = run(t, []string{"new", "--type", "microvm", "--auto-upgrade-from", "monorepo-ci"}, opts{routes: made})
	eq(t, "microvm into", r.Code, 2)
	eq(t, "calls", len(r.Calls), 0)
}

func TestExecSaysACommandNeedsAMicrovm(t *testing.T) {
	needs := command(map[string]any{
		"exitCode": 127, "stderr": "tar: not available in an isolate, which runs only its shell's own commands. Use a microVM.\n",
		"needsMicrovm": map[string]any{"command": "tar", "reason": "An isolate runs only its shell's own commands, and tar isn't one."},
	})
	r := run(t, []string{"exec", "sbx_test1", "--", "tar", "-xf", "a.tar"}, opts{routes: routes{
		commands:   func(call) any { return running(nil) },
		commandOne: func(call) any { return needs },
	}})
	eq(t, "exit", r.Code, 127)
	contains(t, "stderr", r.Stderr, "kantel: tar needs a microVM. kantel upgrade sbx_test1 turns this isolate into one")
}

func TestExecFollowsTheRunAgainAfterAnAutomaticUpgrade(t *testing.T) {
	r := run(t, []string{"exec", "sbx_test1", "--", "git", "status"}, opts{routes: routes{
		commands: func(call) any { return running(nil) },
		commandOne: views(running(nil), command(map[string]any{
			"exitCode": 127, "stderr": "bash: git: command not found\n", "rerunAs": "cmd_2",
			"needsMicrovm": map[string]any{"command": "git", "reason": "An isolate has no git; a microVM does."},
		})),
		"GET /v1/sandboxes/sbx_test1/commands/cmd_2": func(call) any {
			return command(map[string]any{"id": "cmd_2", "stdout": "On branch main\n", "rerunOf": "cmd_1"})
		},
	}})
	eq(t, "exit", r.Code, 0)
	eq(t, "stdout", r.Stdout, "On branch main\n")
	contains(t, "stderr", r.Stderr, "it needed a microVM (git); sbx_test1 is one now, and it runs again there as cmd_2")
}
