package kantel

import (
	"encoding/json"
	"strings"
	"testing"
)

// A sandbox's environments: kantel new --env more than once, kantel env attach, detach and list --sandbox, and the
// sandbox's environments in kantel info and kantel egress.

func sandboxEnvironments(envs ...map[string]any) map[string]any {
	items := []any{}
	for _, e := range envs {
		items = append(items, e)
	}
	return map[string]any{"sandboxId": "sbx_test1", "environments": items}
}

func sandboxEnv(id, name string, pending bool, variables, files, repos []any) map[string]any {
	for _, l := range []*[]any{&variables, &files, &repos} {
		if *l == nil {
			*l = []any{}
		}
	}
	return map[string]any{"id": id, "name": name, "pending": pending,
		"shadowed": map[string]any{"variables": variables, "files": files, "repos": repos}}
}

func TestNewTakesSeveralEnvironmentsInOrder(t *testing.T) {
	create := routes{"POST /v1/sandboxes": func(call) any { return sandbox(nil) }}
	several := run(t, []string{"new", "--env", "backend", "-e", "A=1", "--env", "env_npm1"}, opts{routes: create})
	eq(t, "exit", several.Code, 0)
	jsonEq(t, "body", several.Calls[0].Body, `{"environments":["backend","env_npm1"],"env":{"A":"1"},"wait":true}`)

	one := run(t, []string{"new", "--env", "backend"}, opts{routes: create})
	eq(t, "one exit", one.Code, 0)
	jsonEq(t, "one body", one.Calls[0].Body, `{"environment":"backend","wait":true}`)

	help := run(t, []string{"new", "--help"}, opts{})
	contains(t, "help", help.Stdout, "Give --env <env> more than once")
}

func TestEnvAttach(t *testing.T) {
	answer := sandboxEnvironments(
		sandboxEnv("env_back1", "backend", false, []any{"NODE_ENV"}, []any{"/home/user/.npmrc"}, nil),
		sandboxEnv("env_npm1", "npm", true, nil, nil, nil),
	)
	r := routes{"POST /v1/sandboxes/sbx_test1/environments": func(call) any { return answer }}

	last := run(t, []string{"env", "attach", "sbx_test1", "npm"}, opts{routes: r})
	eq(t, "exit", last.Code, 0)
	jsonEq(t, "body", last.Calls[0].Body, `{"environment":"npm"}`)
	contains(t, "out", last.Stdout, "Attached npm (env_npm1) to sbx_test1.")
	matches(t, "header", last.Stdout, `(?m)^POSITION\s+ID\s+NAME\s+SHADOWED\s+PENDING$`)
	matches(t, "shadowed", last.Stdout, `(?m)^0\s+env_back1\s+backend\s+variables NODE_ENV; files /home/user/\.npmrc\s*$`)
	matches(t, "pending", last.Stdout, `(?m)^1\s+env_npm1\s+npm\s+yes$`)
	contains(t, "pending note", last.Stdout, "Pending: its secret files and repos are set up when the sandbox next runs.")

	first := run(t, []string{"env", "attach", "sbx_test1", "env_back1", "--position", "0", "--json"}, opts{routes: r})
	eq(t, "first exit", first.Code, 0)
	jsonEq(t, "first body", first.Calls[0].Body, `{"environment":"env_back1","position":0}`)
	var shown struct {
		SandboxID    string `json:"sandboxId"`
		Environments []struct {
			ID string `json:"id"`
		} `json:"environments"`
	}
	if err := json.Unmarshal([]byte(first.Stdout), &shown); err != nil {
		t.Fatalf("--json: %v: %q", err, first.Stdout)
	}
	eq(t, "json", len(shown.Environments), 2)

	bad := run(t, []string{"env", "attach", "sbx_test1", "npm", "--position", "-1"}, opts{routes: r})
	eq(t, "bad position", bad.Code, 2)
	eq(t, "bad position calls", len(bad.Calls), 0)

	full := run(t, []string{"env", "attach", "sbx_test1", "eleventh"}, opts{routes: routes{
		"POST /v1/sandboxes/sbx_test1/environments": func(call) any {
			return kantelError(409, "conflict", "A sandbox has at most 10 environments")
		},
	}})
	eq(t, "refused exit", full.Code, 1)
	contains(t, "refused", full.Stderr, "at most 10 environments")
}

func TestEnvDetach(t *testing.T) {
	before := sandboxEnvironments(sandboxEnv("env_back1", "backend", false, nil, nil, nil), sandboxEnv("env_npm1", "npm", false, nil, nil, nil))
	after := sandboxEnvironments(sandboxEnv("env_back1", "backend", false, nil, nil, nil))
	r := routes{
		"GET /v1/sandboxes/sbx_test1/environments":             func(call) any { return before },
		"DELETE /v1/sandboxes/sbx_test1/environments/env_npm1": func(call) any { return after },
	}

	byName := run(t, []string{"env", "detach", "sbx_test1", "npm"}, opts{routes: r})
	eq(t, "exit", byName.Code, 0)
	eq(t, "calls", strings.Join(lines(byName.Calls), ", "),
		"GET /v1/sandboxes/sbx_test1/environments, DELETE /v1/sandboxes/sbx_test1/environments/env_npm1")
	contains(t, "out", byName.Stdout, "Detached npm (env_npm1) from sbx_test1.")
	matches(t, "left", byName.Stdout, `(?m)^0\s+env_back1\s+backend`)

	byID := run(t, []string{"env", "detach", "sbx_test1", "env_npm1", "--json"}, opts{routes: r})
	eq(t, "id exit", byID.Code, 0)
	eq(t, "id calls", strings.Join(lines(byID.Calls), ", "), "DELETE /v1/sandboxes/sbx_test1/environments/env_npm1")
	contains(t, "id json", byID.Stdout, `"sandboxId": "sbx_test1"`)

	missing := run(t, []string{"env", "detach", "sbx_test1", "web"}, opts{routes: r})
	eq(t, "missing exit", missing.Code, 1)
	contains(t, "missing", missing.Stderr, `sbx_test1 has no environment called "web": kantel env ls --sandbox sbx_test1 shows its environments`)
	eq(t, "missing calls", len(missing.Calls), 1)

	empty := run(t, []string{"env", "detach", "sbx_test1", "env_npm1"}, opts{routes: routes{
		"DELETE /v1/sandboxes/sbx_test1/environments/env_npm1": func(call) any { return sandboxEnvironments() },
	}})
	contains(t, "none left", empty.Stdout, "sbx_test1 has no environments. Attach one: kantel env attach sbx_test1 <env>")
}

func TestEnvListForASandbox(t *testing.T) {
	r := routes{"GET /v1/sandboxes/sbx_test1/environments": func(call) any {
		return sandboxEnvironments(
			sandboxEnv("env_back1", "backend", false, []any{"NODE_ENV", "LOG_LEVEL"}, nil, []any{"app"}),
			sandboxEnv("env_npm1", "npm", false, nil, nil, nil),
		)
	}}
	listed := run(t, []string{"env", "ls", "--sandbox", "sbx_test1"}, opts{routes: r})
	eq(t, "exit", listed.Code, 0)
	matches(t, "first", listed.Stdout, `(?m)^0\s+env_back1\s+backend\s+variables NODE_ENV, LOG_LEVEL; repos app\s*$`)
	matches(t, "second", listed.Stdout, `(?m)^1\s+env_npm1\s+npm\s*$`)
	contains(t, "note", listed.Stdout, "Shadowed: set instead by a later environment")
	if strings.Contains(listed.Stdout, "Pending:") {
		t.Errorf("a pending note with nothing pending: %q", listed.Stdout)
	}

	asJSON := run(t, []string{"env", "list", "--sandbox", "sbx_test1", "--json"}, opts{routes: r})
	eq(t, "json exit", asJSON.Code, 0)
	contains(t, "json", asJSON.Stdout, `"shadowed"`)

	gone := run(t, []string{"env", "ls", "--sandbox", "sbx_nope"}, opts{routes: r})
	eq(t, "missing sandbox", gone.Code, 1)
}

func TestInfoAndEgressShowEveryEnvironment(t *testing.T) {
	info := run(t, []string{"info", "sbx_test1"}, opts{routes: routes{
		"GET /v1/sandboxes/sbx_test1": func(call) any {
			return sandbox(map[string]any{"environmentId": "env_back1", "environmentIds": []any{"env_back1", "env_npm1"}})
		},
		"GET /v1/sandboxes/sbx_test1/environments": func(call) any {
			return sandboxEnvironments(sandboxEnv("env_back1", "backend", false, nil, nil, nil), sandboxEnv("env_npm1", "npm", false, nil, nil, nil))
		},
	}})
	eq(t, "info exit", info.Code, 0)
	matches(t, "info", info.Stdout, `environments\s+backend \(env_back1\), npm \(env_npm1\)`)

	// From an older Kantel: one environmentId, and no list to name it from.
	older := run(t, []string{"info", "sbx_test1"}, opts{routes: routes{
		"GET /v1/sandboxes/sbx_test1": func(call) any { return sandbox(map[string]any{"environmentId": "env_back1"}) },
	}})
	eq(t, "older exit", older.Code, 0)
	matches(t, "older", older.Stdout, `environments\s+env_back1\n`)

	// None: no line, and no call for names.
	none := run(t, []string{"info", "sbx_test1"}, opts{routes: routes{
		"GET /v1/sandboxes/sbx_test1": func(call) any { return sandbox(nil) },
	}})
	if strings.Contains(none.Stdout, "environments") {
		t.Errorf("an environments line with none: %q", none.Stdout)
	}
	eq(t, "none calls", len(none.Calls), 1)

	// --json is Kantel's answer alone.
	asJSON := run(t, []string{"info", "sbx_test1", "--json"}, opts{routes: routes{
		"GET /v1/sandboxes/sbx_test1": func(call) any { return sandbox(map[string]any{"environmentIds": []any{"env_back1"}}) },
	}})
	eq(t, "json calls", len(asJSON.Calls), 1)

	egress := run(t, []string{"egress", "sbx_test1"}, opts{routes: routes{"GET /v1/sandboxes/sbx_test1/egress": func(call) any {
		return map[string]any{
			"sandboxId": "sbx_test1", "sandboxName": "brave-otter", "accountId": "acc_1",
			"environment":  map[string]any{"id": "env_back1", "name": "backend"},
			"environments": []any{map[string]any{"id": "env_back1", "name": "backend"}, map[string]any{"id": "env_npm1", "name": "npm"}},
			"protectedVariables": []any{map[string]any{"name": "NPM_TOKEN", "placeholderPrefix": "kph_7Qx2", "environmentId": "env_npm1",
				"bindings": []any{map[string]any{"host": "registry.npmjs.org"}}}},
			"environmentGrants": []any{}, "grants": []any{}, "entries": []any{},
		}
	}}})
	eq(t, "egress exit", egress.Code, 0)
	matches(t, "egress environments", egress.Stdout, `environments\s+backend \(env_back1\), npm \(env_npm1\)`)
	contains(t, "egress protected", egress.Stdout, "NPM_TOKEN (kph_7Qx2…) to registry.npmjs.org from npm (env_npm1)")

	// From an older Kantel: environment alone.
	olderEgress := run(t, []string{"egress", "sbx_test1"}, opts{routes: routes{"GET /v1/sandboxes/sbx_test1/egress": func(call) any {
		return map[string]any{"sandboxId": "sbx_test1", "sandboxName": "brave-otter", "environment": map[string]any{"id": "env_back1", "name": "backend"},
			"protectedVariables": []any{}, "environmentGrants": []any{}, "grants": []any{}, "entries": []any{}}
	}}})
	matches(t, "older egress", olderEgress.Stdout, `environments\s+backend \(env_back1\)\n`)
}
