package kantel

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
)

// Environments, protected variables, grants and the egress log, against a fake Kantel. A protected value must never
// reach stdout or stderr, with or without --json.

const secret = "ghp_s3cretValueThatMustNeverPrint"

var envNow = time.Now().UnixMilli()

func workGrants() []any {
	return []any{map[string]any{"id": "grt_1", "action": "deny", "host": "api.github.com", "methods": []any{"DELETE"}, "paths": []any{"/repos/**"}}}
}

func workRepos() []any {
	return []any{map[string]any{"url": "https://github.com/acme/app", "path": "app"}}
}

func workEnvironment() map[string]any {
	return map[string]any{
		"id": "env_work1", "accountId": "acc_1", "name": "work", "description": "Day job",
		"variables": []any{
			map[string]any{"name": "NODE_ENV", "protected": false, "value": "production", "bindings": []any{}, "updatedAt": envNow},
			map[string]any{"name": "GH_TOKEN", "protected": true, "bindings": []any{map[string]any{"host": "api.github.com"}}, "updatedAt": envNow},
		},
		"files":        []any{map[string]any{"path": "/home/user/.npmrc", "mode": 0o600, "sizeBytes": 42, "updatedAt": envNow}},
		"repos":        workRepos(),
		"grants":       workGrants(),
		"sandboxCount": 2, "createdAt": envNow, "updatedAt": envNow,
	}
}

var envCaller = map[string]any{"accountId": "acc_1", "accounts": []any{}, "superAdmin": false, "mode": "hosted", "protectedValues": true}

// envRoutes find work by name and answer it, on a deployment that keeps protected values; more are added on top.
func envRoutes(more routes) routes {
	r := routes{
		"GET /v1/whoami":                 func(call) any { return envCaller },
		"GET /v1/environments":           func(call) any { return map[string]any{"items": []any{workEnvironment()}} },
		"GET /v1/environments/env_work1": func(call) any { return workEnvironment() },
	}
	for k, v := range more {
		r[k] = v
	}
	return r
}

func with(m map[string]any, kv ...any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		out[k] = v
	}
	for i := 0; i+1 < len(kv); i += 2 {
		out[kv[i].(string)] = kv[i+1]
	}
	return out
}

func lines(calls []call) []string {
	var out []string
	for _, c := range calls {
		out = append(out, c.Method+" "+c.Path)
	}
	return out
}

func last(r result) call {
	if len(r.Calls) == 0 {
		return call{}
	}
	return r.Calls[len(r.Calls)-1]
}

// jsonEq says whether got, a call's body, is want as JSON.
func jsonEq(t *testing.T, what string, got map[string]any, want string) {
	t.Helper()
	var w any
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("%s: bad want: %v", what, err)
	}
	g, _ := json.Marshal(got)
	var gn any
	_ = json.Unmarshal(g, &gn)
	if !reflect.DeepEqual(gn, w) {
		t.Errorf("%s: got %s, want %s", what, g, want)
	}
}

func matches(t *testing.T, what, got, pattern string) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(got) {
		t.Errorf("%s: %q doesn't match %s", what, got, pattern)
	}
}

func noSecret(t *testing.T, what string, r result) {
	t.Helper()
	if strings.Contains(r.Stdout+r.Stderr, secret) {
		t.Errorf("%s printed the secret: %q %q", what, r.Stdout, r.Stderr)
	}
}

func TestBindings(t *testing.T) {
	cases := map[string]string{
		"api.github.com":              `{"host":"api.github.com"}`,
		"api.openai.com/v1/:POST,GET": `{"host":"api.openai.com","pathPrefixes":["/v1/"],"methods":["POST","GET"]}`,
		"API.GitHub.com/repos/:get":   `{"host":"api.github.com","pathPrefixes":["/repos/"],"methods":["GET"]}`,
		"api.github.com:PUT":          `{"host":"api.github.com","methods":["PUT"]}`,
		"*.example.com":               `{"host":"*.example.com"}`,
		"api.github.com/":             `{"host":"api.github.com"}`,
		// A colon not followed by methods stays in the path.
		"generativelanguage.googleapis.com/v1/models/m:generateContent": `{"host":"generativelanguage.googleapis.com","pathPrefixes":["/v1/models/m:generateContent"]}`,
	}
	for text, want := range cases {
		b, err := parseBinding(text)
		if err != nil {
			t.Errorf("%s: %v", text, err)
			continue
		}
		got, _ := json.Marshal(b)
		var g, w any
		_ = json.Unmarshal(got, &g)
		_ = json.Unmarshal([]byte(want), &w)
		if !reflect.DeepEqual(g, w) {
			t.Errorf("%s: got %s, want %s", text, got, want)
		}
	}
	refused := map[string]string{
		"https://api.github.com":  "not a URL",
		"api.github.com:443":      "no port",
		"api.github.com/user?x=1": "no query",
		"api github":              "isn't a host name",
		"api.*.com":               "isn't a host name",
		"api.github.com:":         "no port",
	}
	for text, want := range refused {
		if _, err := parseBinding(text); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got %v, want %q", text, err, want)
		}
	}

	var parsed []api.DestinationBinding
	for _, text := range []string{"api.github.com/repos/", "api.github.com/user", "api.openai.com:POST", "api.openai.com/v1/:POST"} {
		b, _ := parseBinding(text)
		parsed = append(parsed, b)
	}
	merged := mergeBindings(parsed)
	got, _ := json.Marshal(merged)
	eq(t, "merged", string(got), `[{"host":"api.github.com","pathPrefixes":["/repos/","/user"]},{"host":"api.openai.com","methods":["POST"]}]`)
	var texts []string
	for _, b := range merged {
		texts = append(texts, bindingTexts(b)...)
	}
	eq(t, "texts", strings.Join(texts, " "), "api.github.com/repos/ api.github.com/user api.openai.com:POST")
}

func TestWithoutProtectedValues(t *testing.T) {
	leaky := `{"items":[{"variables":[{"name":"A","protected":true,"value":"` + secret + `"},{"name":"B","value":"b"}]}]}`
	eq(t, "kept", string(WithoutProtectedValues(json.RawMessage(leaky))),
		`{"items":[{"variables":[{"name":"A","protected":true},{"name":"B","value":"b"}]}]}`)
}

func TestEnvSet(t *testing.T) {
	// Kantel answering the variable, as it never should, with its value.
	leaky := func(c call) any { return with(c.Body, "name", "OPENAI_API_KEY", "updatedAt", envNow) }
	setRoutes := func(answer func(call) any) routes {
		return envRoutes(routes{
			"PUT /v1/environments/env_work1/variables/OPENAI_API_KEY": answer,
			"PUT /v1/environments/env_work1/variables/GH_TOKEN":       answer,
			"PUT /v1/environments/env_work1/variables/NODE_ENV":       answer,
		})
	}

	t.Run("a protected variable bound to its destinations, by the environment's name", func(t *testing.T) {
		r := run(t, []string{"env", "set", "work", "OPENAI_API_KEY=" + secret, "--protected",
			"--bind", "api.openai.com/v1/:POST,GET", "--bind", "api.openai.com/v2/:GET,POST"}, opts{routes: setRoutes(leaky)})
		eq(t, "exit", r.Code, 0)
		eq(t, "calls", strings.Join(lines(r.Calls), ", "), "GET /v1/whoami, GET /v1/environments, GET /v1/environments/env_work1, PUT /v1/environments/env_work1/variables/OPENAI_API_KEY")
		jsonEq(t, "body", last(r).Body, `{"protected":true,"value":"`+secret+`","bindings":[{"host":"api.openai.com","pathPrefixes":["/v1/","/v2/"],"methods":["POST","GET"]}]}`)
		contains(t, "out", r.Stdout, "Set OPENAI_API_KEY in work: protected, sent only to api.openai.com/v1/:POST,GET")
		noSecret(t, "set", r)
	})

	t.Run("never prints the value with --json, even when Kantel answers it", func(t *testing.T) {
		r := run(t, []string{"env", "set", "env_work1", "OPENAI_API_KEY=" + secret, "--protected", "--bind", "api.openai.com", "--json"},
			opts{routes: setRoutes(leaky)})
		eq(t, "exit", r.Code, 0)
		eq(t, "calls", strings.Join(lines(r.Calls), ", "), "GET /v1/whoami, GET /v1/environments/env_work1, PUT /v1/environments/env_work1/variables/OPENAI_API_KEY")
		noSecret(t, "--json", r)
		var shown map[string]any
		if err := json.Unmarshal([]byte(r.Stdout), &shown); err != nil {
			t.Fatal(err)
		}
		eq(t, "name", shown["name"], any("OPENAI_API_KEY"))
		eq(t, "protected", shown["protected"], any(true))
	})

	t.Run("reads the value from stdin, and takes the environment as --env", func(t *testing.T) {
		r := run(t, []string{"env", "set", "--env", "work", "OPENAI_API_KEY", "--value-stdin", "--protected", "--bind", "api.openai.com/v1/:POST"},
			opts{routes: setRoutes(leaky), stdin: secret + "\n"})
		eq(t, "exit", r.Code, 0)
		jsonEq(t, "body", last(r).Body, `{"protected":true,"value":"`+secret+`","bindings":[{"host":"api.openai.com","pathPrefixes":["/v1/"],"methods":["POST"]}]}`)
		noSecret(t, "stdin", r)
	})

	t.Run("refuses an empty stdin, and help says why --value-stdin is there", func(t *testing.T) {
		r := run(t, []string{"env", "set", "work", "GH_TOKEN", "--value-stdin"}, opts{routes: setRoutes(leaky)})
		eq(t, "exit", r.Code, 2)
		contains(t, "err", r.Stderr, "no value on stdin")
		eq(t, "calls", len(r.Calls), 0)
		help := run(t, []string{"env", "set", "--help"}, opts{})
		contains(t, "usage", help.Stdout, "Usage: kantel env set <env> <NAME>[=<value>]")
		contains(t, "why", help.Stdout, "keeps it out of your shell history")
	})

	t.Run("rotates a protected variable: it stays protected, on the bindings it has", func(t *testing.T) {
		r := run(t, []string{"env", "set", "work", "GH_TOKEN", "--value-stdin"}, opts{routes: setRoutes(leaky), stdin: secret})
		eq(t, "exit", r.Code, 0)
		jsonEq(t, "body", r.Calls[2].Body, `{"protected":true,"value":"`+secret+`"}`)
		contains(t, "verb", r.Stdout, "Rotated GH_TOKEN in work")
		contains(t, "placeholder", r.Stdout, "same placeholder")
		noSecret(t, "rotate", r)
	})

	t.Run("says what Kantel has after a rotation, not what it read before", func(t *testing.T) {
		answer := workEnvironment()
		answer["variables"] = []any{
			map[string]any{"name": "NODE_ENV", "protected": false, "value": "production", "bindings": []any{}, "updatedAt": envNow},
			map[string]any{"name": "GH_TOKEN", "protected": true, "updatedAt": envNow,
				"bindings": []any{map[string]any{"host": "api.github.com", "pathPrefixes": []any{"/repos/acme/"}, "methods": []any{"GET"}}}},
		}
		r := run(t, []string{"env", "set", "work", "GH_TOKEN", "--value-stdin"}, opts{routes: setRoutes(func(call) any { return answer }), stdin: secret})
		eq(t, "exit", r.Code, 0)
		jsonEq(t, "body", r.Calls[2].Body, `{"protected":true,"value":"`+secret+`"}`)
		contains(t, "out", r.Stdout, "Rotated GH_TOKEN in work: protected, sent only to api.github.com/repos/acme/:GET")
		noSecret(t, "rotate", r)
	})

	t.Run("re-binds a protected variable with --keep-value, sending no value", func(t *testing.T) {
		r := run(t, []string{"env", "set", "work", "GH_TOKEN", "--keep-value", "--bind", "api.github.com/repos/:GET"}, opts{routes: setRoutes(leaky)})
		eq(t, "exit", r.Code, 0)
		jsonEq(t, "body", last(r).Body, `{"protected":true,"bindings":[{"host":"api.github.com","pathPrefixes":["/repos/"],"methods":["GET"]}]}`)
		plain := run(t, []string{"env", "set", "work", "NODE_ENV", "--keep-value", "--bind", "api.github.com"}, opts{routes: setRoutes(leaky)})
		eq(t, "plain exit", plain.Code, 1)
		contains(t, "plain", plain.Stderr, "NODE_ENV isn't protected in work")
	})

	t.Run("refuses a protected value or secret file before writing anything where the deployment keeps none", func(t *testing.T) {
		r := setRoutes(leaky)
		r["GET /v1/whoami"] = func(call) any { return with(envCaller, "protectedValues", false) }
		r["PUT /v1/environments/env_work1/files"] = func(call) any { return workEnvironment() }
		r["POST /v1/environments"] = func(call) any { return with(workEnvironment(), "id", "env_new1", "name", "new") }
		for _, argv := range [][]string{
			{"env", "set", "work", "OPENAI_API_KEY=" + secret, "--protected", "--bind", "api.openai.com"},
			{"env", "set", "work", "GH_TOKEN", "--keep-value", "--bind", "api.github.com"},
		} {
			refused := run(t, argv, opts{routes: r})
			eq(t, "exit", refused.Code, 1)
			contains(t, "err", refused.Stderr, "this deployment doesn't support protected variables or secret files")
			eq(t, "calls", strings.Join(lines(refused.Calls), ", "), "GET /v1/whoami")
		}
		file := run(t, []string{"env", "file", "work", "/etc/key"}, opts{routes: r, stdin: secret})
		eq(t, "file exit", file.Code, 1)
		eq(t, "file calls", strings.Join(lines(file.Calls), ", "), "GET /v1/whoami")

		// Plain variables need no check, and making an environment says up front that protected values can't go in it.
		plain := run(t, []string{"env", "set", "work", "NODE_ENV=test"}, opts{routes: r})
		eq(t, "plain exit", plain.Code, 0)
		if strings.Contains(strings.Join(lines(plain.Calls), ","), "whoami") {
			t.Error("a plain variable asked whoami")
		}
		created := run(t, []string{"env", "create", "new"}, opts{routes: r})
		eq(t, "create exit", created.Code, 0)
		contains(t, "note", created.Stdout, "Note: this deployment doesn't support protected variables or secret files")
		offered := run(t, []string{"env", "create", "new"}, opts{routes: envRoutes(routes{"POST /v1/environments": r["POST /v1/environments"]})})
		if strings.Contains(offered.Stdout, "Note:") {
			t.Errorf("a note where protected values are kept: %q", offered.Stdout)
		}
	})

	t.Run("tries the write on an older deployment that doesn't say", func(t *testing.T) {
		r := setRoutes(leaky)
		r["GET /v1/whoami"] = func(call) any { return map[string]any{"accountId": "acc_1"} }
		res := run(t, []string{"env", "set", "work", "OPENAI_API_KEY=" + secret, "--protected", "--bind", "api.openai.com"}, opts{routes: r})
		eq(t, "exit", res.Code, 0)
		eq(t, "last", last(res).Path, "/v1/environments/env_work1/variables/OPENAI_API_KEY")
	})

	t.Run("sets a plain variable, and --plain makes a protected one plain", func(t *testing.T) {
		plain := run(t, []string{"env", "set", "work", "NODE_ENV=test"}, opts{routes: setRoutes(leaky)})
		eq(t, "exit", plain.Code, 0)
		jsonEq(t, "body", plain.Calls[2].Body, `{"value":"test"}`)
		unprotected := run(t, []string{"env", "set", "work", "GH_TOKEN=public", "--plain"}, opts{routes: setRoutes(leaky)})
		jsonEq(t, "plain body", unprotected.Calls[2].Body, `{"protected":false,"value":"public"}`)
	})

	t.Run("refuses a muddled command line before calling Kantel, without echoing the value", func(t *testing.T) {
		for _, argv := range [][]string{
			{"env", "set", "work", "GH_TOKEN"},
			{"env", "set", "work", "GH_TOKEN=" + secret, "--value-stdin"},
			{"env", "set", "work", "GH TOKEN=" + secret},
			{"env", "set", "work", "GH_TOKEN=" + secret, "--plain", "--bind", "api.github.com"},
			{"env", "set", "work", "GH_TOKEN", "--keep-value"},
			{"env", "set", "GH_TOKEN=" + secret},
			{"env", "set", "work", "GH_TOKEN=" + secret, "--bind", "https://api.github.com"},
		} {
			r := run(t, argv, opts{routes: setRoutes(leaky)})
			eq(t, strings.Join(argv, " "), r.Code, 2)
			eq(t, strings.Join(argv, " ")+" calls", len(r.Calls), 0)
			noSecret(t, strings.Join(argv, " "), r)
		}
	})

	t.Run("needs a --bind for a new protected variable", func(t *testing.T) {
		r := run(t, []string{"env", "set", "work", "NEW_TOKEN=" + secret, "--protected"}, opts{routes: setRoutes(leaky)})
		eq(t, "exit", r.Code, 2)
		contains(t, "err", r.Stderr, "needs --bind")
		for _, l := range lines(r.Calls) {
			if strings.HasPrefix(l, "PUT") {
				t.Errorf("wrote: %s", l)
			}
		}
		noSecret(t, "new", r)
	})
}

func TestEnvShowAndList(t *testing.T) {
	leaky := workEnvironment()
	leaky["variables"] = []any{
		map[string]any{"name": "NODE_ENV", "protected": false, "value": "production", "bindings": []any{}, "updatedAt": envNow},
		map[string]any{"name": "GH_TOKEN", "protected": true, "value": secret, "bindings": []any{map[string]any{"host": "api.github.com"}}, "updatedAt": envNow},
	}
	r := routes{
		"GET /v1/environments":           func(call) any { return map[string]any{"items": []any{leaky}} },
		"GET /v1/environments/env_work1": func(call) any { return leaky },
	}
	shown := run(t, []string{"env", "show", "work"}, opts{routes: r})
	eq(t, "exit", shown.Code, 0)
	matches(t, "plain", shown.Stdout, `NODE_ENV\s+production`)
	matches(t, "protected", shown.Stdout, `GH_TOKEN\s+protected\s+api\.github\.com`)
	matches(t, "file", shown.Stdout, `/home/user/\.npmrc\s+0600\s+42 B`)
	contains(t, "repo", shown.Stdout, "https://github.com/acme/app")
	matches(t, "grant", shown.Stdout, `grt_1\s+deny DELETE api\.github\.com /repos/\*\*`)
	noSecret(t, "show", shown)

	for _, argv := range [][]string{{"env", "show", "work", "--json"}, {"env", "list", "--json"}, {"env", "list"}} {
		res := run(t, argv, opts{routes: r})
		eq(t, strings.Join(argv, " "), res.Code, 0)
		noSecret(t, strings.Join(argv, " "), res)
	}
	listed := run(t, []string{"env", "ls"}, opts{routes: r})
	matches(t, "list", listed.Stdout, `env_work1\s+work\s+2\s+1\s+1\s+1\s+2`)

	missing := run(t, []string{"env", "show", "home"}, opts{routes: r})
	eq(t, "missing exit", missing.Code, 1)
	contains(t, "missing", missing.Stderr, `there is no environment called "home"`)

	group := run(t, []string{"env"}, opts{})
	eq(t, "group exit", group.Code, 0)
	for _, name := range []string{"env set", "env file rm", "env repo add", "env grant rm"} {
		contains(t, "group", group.Stdout, name)
	}
}

func TestEnvFilesReposAndGrants(t *testing.T) {
	t.Run("says the mode a secret file has once saved", func(t *testing.T) {
		saved := func(mode int) func(call) any {
			return func(call) any {
				return with(workEnvironment(), "files", []any{map[string]any{"path": "/home/user/.npmrc", "mode": mode, "sizeBytes": 3, "updatedAt": envNow}})
			}
		}
		kept := run(t, []string{"env", "file", "work", "~/.npmrc"}, opts{routes: envRoutes(routes{"PUT /v1/environments/env_work1/files": saved(0o644)}), stdin: "abc"})
		eq(t, "exit", kept.Code, 0)
		jsonEq(t, "body", last(kept).Body, `{"path":"~/.npmrc","content":"YWJj","encoding":"base64"}`)
		contains(t, "out", kept.Stdout, "Saved ~/.npmrc (3 B, mode 0644) in work.")
		fresh := run(t, []string{"env", "file", "work", ".npmrc"}, opts{routes: envRoutes(routes{"PUT /v1/environments/env_work1/files": saved(0o600)}), stdin: "abc"})
		contains(t, "fresh", fresh.Stdout, "mode 0600")
	})

	t.Run("sends a secret file's content as base64, from --from or stdin, and removes one", func(t *testing.T) {
		dir := t.TempDir()
		local := filepath.Join(dir, "npmrc")
		content := "//registry.npmjs.org/:_authToken=secret\n"
		if err := os.WriteFile(local, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		r := envRoutes(routes{
			"PUT /v1/environments/env_work1/files":    func(call) any { return workEnvironment() },
			"DELETE /v1/environments/env_work1/files": func(call) any { return nil },
		})
		fromFile := run(t, []string{"env", "file", "work", "/home/user/.npmrc", "--from", local, "--mode", "0640"}, opts{routes: r})
		eq(t, "exit", fromFile.Code, 0)
		jsonEq(t, "body", last(fromFile).Body, `{"path":"/home/user/.npmrc","mode":416,"content":"Ly9yZWdpc3RyeS5ucG1qcy5vcmcvOl9hdXRoVG9rZW49c2VjcmV0Cg==","encoding":"base64"}`)
		fromStdin := run(t, []string{"env", "file", "env_work1", "/etc/key"}, opts{routes: r, stdin: "abc"})
		jsonEq(t, "stdin body", last(fromStdin).Body, `{"path":"/etc/key","content":"YWJj","encoding":"base64"}`)
		noContent := run(t, []string{"env", "file", "work", "/etc/key"}, opts{routes: r, stdinTTY: true})
		eq(t, "no content exit", noContent.Code, 2)
		eq(t, "no content calls", len(noContent.Calls), 0)
		removed := run(t, []string{"env", "file", "rm", "work", "/home/user/.npmrc"}, opts{routes: r})
		eq(t, "rm exit", removed.Code, 0)
		eq(t, "rm call", last(removed).Method+" "+last(removed).Path, "DELETE /v1/environments/env_work1/files")
		eq(t, "rm path", strings.Join(last(removed).Query["path"], ""), "/home/user/.npmrc")
	})

	t.Run("adds and removes repos, replacing one with the same URL", func(t *testing.T) {
		r := envRoutes(routes{"PUT /v1/environments/env_work1/repos": func(call) any { return workEnvironment() }})
		added := run(t, []string{"env", "repo", "add", "work", "https://github.com/acme/app", "--ref", "main"}, opts{routes: r})
		eq(t, "exit", added.Code, 0)
		// With the list as read, so Kantel refuses the write when it has changed since.
		jsonEq(t, "body", last(added).Body, `{"repos":[{"url":"https://github.com/acme/app","ref":"main"}],"expected":[{"url":"https://github.com/acme/app","path":"app"}]}`)
		removed := run(t, []string{"env", "repo", "rm", "work", "https://github.com/acme/app"}, opts{routes: r})
		jsonEq(t, "rm body", last(removed).Body, `{"repos":[],"expected":[{"url":"https://github.com/acme/app","path":"app"}]}`)
		notHTTPS := run(t, []string{"env", "repo", "add", "work", "git@github.com:acme/app.git"}, opts{routes: r})
		eq(t, "not https", notHTTPS.Code, 2)
	})

	t.Run("sends an empty list as read as [], not left out", func(t *testing.T) {
		r := envRoutes(routes{"PUT /v1/environments/env_work1/repos": func(call) any { return workEnvironment() }})
		r["GET /v1/environments/env_work1"] = func(call) any { return with(workEnvironment(), "repos", []any{}) }
		added := run(t, []string{"env", "repo", "add", "env_work1", "https://github.com/acme/web"}, opts{routes: r})
		eq(t, "exit", added.Code, 0)
		eq(t, "raw", string(last(added).Raw), `{"repos":[{"url":"https://github.com/acme/web"}],"expected":[]}`)
	})

	t.Run("reads the list again and redoes the edit when Kantel says it changed since it was read", func(t *testing.T) {
		theirs := map[string]any{"id": "grt_7", "action": "allow", "host": "registry.npmjs.org"}
		reads := 0
		r := envRoutes(routes{
			"GET /v1/environments/env_work1": func(call) any {
				reads++
				if reads == 1 {
					return workEnvironment()
				}
				return with(workEnvironment(), "grants", append(workGrants(), theirs))
			},
			"PUT /v1/environments/env_work1/grants": func(c call) any {
				if len(c.Body["expected"].([]any)) != 2 {
					return kantelError(409, "conflict", "The environment's grants changed")
				}
				var grants []any
				for i, g := range c.Body["grants"].([]any) {
					grants = append(grants, with(g.(map[string]any), "id", "grt_"+string(rune('0'+i))))
				}
				return with(workEnvironment(), "grants", grants)
			},
		})
		res := run(t, []string{"env", "grant", "env_work1", "deny", "*", "--method", "DELETE"}, opts{routes: r})
		eq(t, "exit", res.Code, 0)
		var puts []call
		for _, c := range res.Calls {
			if c.Method == "PUT" {
				puts = append(puts, c)
			}
		}
		eq(t, "puts", len(puts), 2)
		// The second write is made on the list as it is now: their grant is kept.
		jsonEq(t, "second", puts[1].Body, `{"grants":[
			{"id":"grt_1","action":"deny","host":"api.github.com","methods":["DELETE"],"paths":["/repos/**"]},
			{"id":"grt_7","action":"allow","host":"registry.npmjs.org"},
			{"action":"deny","host":"*","methods":["DELETE"]}],
			"expected":[
			{"id":"grt_1","action":"deny","host":"api.github.com","methods":["DELETE"],"paths":["/repos/**"]},
			{"id":"grt_7","action":"allow","host":"registry.npmjs.org"}]}`)

		// One that keeps changing is a conflict in the end, not a write over it.
		busy := envRoutes(routes{"PUT /v1/environments/env_work1/repos": func(call) any {
			return kantelError(409, "conflict", "The environment's repositories changed")
		}})
		refused := run(t, []string{"env", "repo", "add", "env_work1", "https://github.com/acme/web"}, opts{routes: busy})
		eq(t, "refused exit", refused.Code, 1)
		n := 0
		for _, c := range refused.Calls {
			if c.Method == "PUT" {
				n++
			}
		}
		eq(t, "tries", n, 3)
		contains(t, "refused", refused.Stderr, "changed")
	})

	t.Run("adds an environment grant beside the ones it has, and removes one by ID", func(t *testing.T) {
		added := map[string]any{"id": "grt_2", "action": "allow", "host": "api.github.com", "methods": []any{"GET"}}
		r := envRoutes(routes{"PUT /v1/environments/env_work1/grants": func(c call) any {
			var grants []any
			for _, g := range c.Body["grants"].([]any) {
				if _, ok := g.(map[string]any)["id"]; !ok {
					g = added
				}
				grants = append(grants, g)
			}
			return with(workEnvironment(), "grants", grants)
		}})
		res := run(t, []string{"env", "grant", "work", "allow", "API.github.com", "--method", "get"}, opts{routes: r})
		eq(t, "exit", res.Code, 0)
		jsonEq(t, "body", last(res).Body, `{"grants":[
			{"id":"grt_1","action":"deny","host":"api.github.com","methods":["DELETE"],"paths":["/repos/**"]},
			{"action":"allow","host":"api.github.com","methods":["GET"]}],
			"expected":[{"id":"grt_1","action":"deny","host":"api.github.com","methods":["DELETE"],"paths":["/repos/**"]}]}`)
		contains(t, "out", res.Stdout, `Added "allow GET api.github.com" (grt_2) to work.`)
		removed := run(t, []string{"env", "grant", "rm", "work", "grt_1"}, opts{routes: r})
		eq(t, "rm exit", removed.Code, 0)
		jsonEq(t, "rm body", last(removed).Body, `{"grants":[],"expected":[{"id":"grt_1","action":"deny","host":"api.github.com","methods":["DELETE"],"paths":["/repos/**"]}]}`)
		unknown := run(t, []string{"env", "grant", "rm", "work", "grt_9"}, opts{routes: r})
		eq(t, "unknown exit", unknown.Code, 1)
		contains(t, "unknown", unknown.Stderr, "work has no grant grt_9")
	})
}

func TestSandboxGrantsAndEgress(t *testing.T) {
	sbx := func(grants []any) map[string]any {
		return map[string]any{"id": "sbx_test1", "name": "brave-otter", "state": "running", "grants": grants}
	}
	t.Run("adds and removes a sandbox's own grants", func(t *testing.T) {
		r := routes{
			"GET /v1/sandboxes/sbx_test1": func(call) any {
				return sbx([]any{map[string]any{"id": "grt_5", "action": "allow", "host": "*"}})
			},
			"PUT /v1/sandboxes/sbx_test1/grants": func(c call) any {
				var grants []any
				for _, g := range c.Body["grants"].([]any) {
					m := g.(map[string]any)
					if _, ok := m["id"]; !ok {
						m = with(m, "id", "grt_6")
					}
					grants = append(grants, m)
				}
				return sbx(grants)
			},
		}
		added := run(t, []string{"grant", "sbx_test1", "deny", "api.github.com", "--method", "DELETE", "--path", "/repos/**"}, opts{routes: r})
		eq(t, "exit", added.Code, 0)
		jsonEq(t, "body", last(added).Body, `{"grants":[{"id":"grt_5","action":"allow","host":"*"},
			{"action":"deny","host":"api.github.com","methods":["DELETE"],"paths":["/repos/**"]}],
			"expected":[{"id":"grt_5","action":"allow","host":"*"}]}`)
		contains(t, "out", added.Stdout, `Added "deny DELETE api.github.com /repos/**" (grt_6) to sbx_test1.`)
		removed := run(t, []string{"grant", "rm", "sbx_test1", "grt_5"}, opts{routes: r})
		eq(t, "rm exit", removed.Code, 0)
		eq(t, "rm calls", strings.Join(lines(removed.Calls), ", "), "GET /v1/sandboxes/sbx_test1, PUT /v1/sandboxes/sbx_test1/grants")
		jsonEq(t, "rm body", last(removed).Body, `{"grants":[],"expected":[{"id":"grt_5","action":"allow","host":"*"}]}`)
		badPath := run(t, []string{"grant", "sbx_test1", "deny", "api.github.com", "--path", "repos"}, opts{routes: r})
		eq(t, "bad path", badPath.Code, 2)
		eq(t, "bad path calls", len(badPath.Calls), 0)
	})

	t.Run("prints the egress log as a table, and only refusals with --denied", func(t *testing.T) {
		at := func(sec int) int64 { return time.Date(2026, 11, 3, 14, 5, sec, 0, time.UTC).UnixMilli() }
		egress := map[string]any{
			"sandboxId": "sbx_test1", "sandboxName": "brave-otter", "accountId": "acc_1",
			"environment": map[string]any{"id": "env_work1", "name": "work"},
			"protectedVariables": []any{map[string]any{"name": "GH_TOKEN", "placeholderPrefix": "kph_7Qx2",
				"bindings": []any{map[string]any{"host": "api.github.com"}}}},
			"environmentGrants": workGrants(), "grants": []any{},
			"entries": []any{
				map[string]any{"id": "egr_2", "at": at(9), "method": "POST", "host": "evil.example", "port": 443, "path": "/collect",
					"decision": "denied", "code": "placeholder-unbound", "swapped": []any{}, "inspected": true, "status": 403, "bytesUp": 0, "bytesDown": 0},
				map[string]any{"id": "egr_1", "at": at(2), "method": "GET", "host": "api.github.com", "port": 443, "path": "/user",
					"decision": "allowed", "swapped": []any{"GH_TOKEN"}, "inspected": true, "status": 200, "bytesUp": 120, "bytesDown": 900},
			},
		}
		r := routes{"GET /v1/sandboxes/sbx_test1/egress": func(call) any { return egress }}
		all := run(t, []string{"egress", "sbx_test1", "--limit", "50"}, opts{routes: r})
		eq(t, "exit", all.Code, 0)
		eq(t, "limit", strings.Join(all.Calls[0].Query["limit"], ""), "50")
		contains(t, "protected", all.Stdout, "GH_TOKEN (kph_7Qx2…) to api.github.com")
		matches(t, "header", all.Stdout, `(?m)^TIME\s+METHOD\s+DESTINATION\s+DECISION\s+CODE/RULE\s+SWAPPED$`)
		matches(t, "denied", all.Stdout, `2026-11-03 14:05:09\s+POST\s+evil\.example/collect\s+denied 403\s+placeholder-unbound`)
		matches(t, "allowed", all.Stdout, `GET\s+api\.github\.com/user\s+allowed 200\s+GH_TOKEN`)
		denied := run(t, []string{"egress", "sbx_test1", "--denied", "--json"}, opts{routes: r})
		var shown struct {
			SandboxID string `json:"sandboxId"`
			Entries   []struct {
				ID string `json:"id"`
			} `json:"entries"`
		}
		if err := json.Unmarshal([]byte(denied.Stdout), &shown); err != nil {
			t.Fatal(err)
		}
		eq(t, "entries", len(shown.Entries), 1)
		eq(t, "entry", shown.Entries[0].ID, "egr_2")
		eq(t, "rest kept", shown.SandboxID, "sbx_test1")
	})
}
