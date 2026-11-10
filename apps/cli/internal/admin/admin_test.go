package admin

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

func host(fields map[string]any) map[string]any {
	h := map[string]any{
		"id": "host_6t5r4e", "name": "builder-1", "state": "online", "version": "0.4.0", "latestVersion": "0.5.0",
		"updateAvailable": true, "os": "linux", "arch": "x86_64", "tiers": []string{"microvm", "isolate"}, "kvm": true,
		"nestedVirtualisation": false, "capacity": map[string]any{"vcpus": 16, "memoryMb": 65536, "diskGb": 500},
		"allocated": map[string]any{"sandboxes": 3, "vcpus": 6, "memoryMb": 12288, "diskGb": 60},
		"labels":    map[string]any{"zone": "ams"}, "joinedAt": time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC).UnixMilli(),
		"lastSeenAt": time.Now().UnixMilli() - 5000,
	}
	for k, v := range fields {
		h[k] = v
	}
	return h
}

func ptr(s string) *string { return &s }

func TestEnvFile(t *testing.T) {
	settings := ParseEnvFile("# a comment\nA=1\nexport B='two words'\nA=3\nnot a setting\n")
	eq(t, "parsed", jsonOf(t, orderedObject(settings)), `{"A":"3","B":"two words"}`)

	changed := UpdateEnvFile("# keep me\nA=1\nB=2\nA=again\nC=3\n", Changes{{"A", ptr("10")}, {"C", nil}, {"D", ptr("4")}})
	eq(t, "updated", changed, "# keep me\nA=10\nB=2\nD=4\n")
	eq(t, "emptied", UpdateEnvFile("A=1\n", Changes{{"A", nil}}), "")
}

func TestInstallAndUpgrade(t *testing.T) {
	tt := newTester(t)
	r := tt.run([]string{"install", "--email", "me@example.com", "--no-open", "--", "--extra"},
		opts{routes: routes{"GET https://kantel.dev/install.sh": func(call) any { return "echo installer" }}})
	eq(t, "exit", r.Code, 0)
	eq(t, "calls", len(r.Calls), 1)
	eq(t, "path", r.Calls[0].Path, "/install.sh")
	eq(t, "spawned", len(r.Spawned), 1)
	s := r.Spawned[0]
	eq(t, "command", s.Command, "sh")
	eq(t, "args", strings.Join(s.Args, " "), "-s -- --email me@example.com --no-open --extra")
	eq(t, "input", *s.Input, "echo installer")
	contains(t, "note", r.Err, "running https://kantel.dev/install.sh")

	// upgrade adds --upgrade and --home, and passes the installer's exit code back.
	script := filepath.Join(tt.home, "install.sh")
	if err := os.WriteFile(script, []byte("echo local"), 0o644); err != nil {
		t.Fatal(err)
	}
	r = tt.run([]string{"upgrade", "--home", "/srv/kantel"}, opts{env: cli.Env{"KANTEL_INSTALLER_URL": script},
		ran: func(spawned) (Ran, error) { return Ran{Code: 3}, nil }})
	eq(t, "upgrade exit", r.Code, 3)
	eq(t, "upgrade args", strings.Join(r.Spawned[0].Args, " "), "-s -- --home /srv/kantel --upgrade")
	eq(t, "upgrade input", *r.Spawned[0].Input, "echo local")

	r = tt.run([]string{"install"}, opts{})
	eq(t, "download failed", r.Code, 1)
	contains(t, "download failed", r.Err, "couldn't download the installer from https://kantel.dev/install.sh: HTTP 404")
	eq(t, "nothing ran", len(r.Spawned), 0)
}

func TestStatus(t *testing.T) {
	tt := newTester(t)
	tt.install("KANTEL_GATEWAY_PORT=58123\nKANTEL_COMPUTE=experimental\n")
	r := tt.run([]string{"status"}, opts{
		routes: routes{"GET http://127.0.0.1:58123/healthz": func(call) any { return map[string]any{"ok": true} }},
		ran: func(spawned) (Ran, error) {
			return Ran{Stdout: "gateway running\npostgres running\nworker exited\n"}, nil
		},
	})
	eq(t, "exit", r.Code, 0)
	eq(t, "health", r.Calls[0].Path, "/healthz")
	eq(t, "compose", strings.Join(r.Spawned[0].Args[:3], " "),
		"compose -f "+filepath.Join(tt.home, ".kantel/src/deploy/compose/compose.yaml"))
	eq(t, "captured", r.Spawned[0].Capture, true)
	contains(t, "console", r.Out, "http://127.0.0.1:58123 (answering)")
	contains(t, "services", r.Out, "2 of 3 running")
	contains(t, "backend", r.Out, "your hosts")
	contains(t, "public", r.Out, "hosts on this machine join at http://127.0.0.1:58123")

	// It exits 1 when the console doesn't answer, and says when nothing is installed.
	missing := newTester(t).run([]string{"status"}, opts{})
	eq(t, "missing exit", missing.Code, 1)
	contains(t, "missing", missing.Err, "there is no Kantel install in")

	tt = newTester(t)
	tt.install(defaultEnv)
	down := tt.run([]string{"status", "--json"}, opts{unreachable: true})
	eq(t, "down exit", down.Code, 1)
	var got map[string]any
	if err := json.Unmarshal([]byte(down.Out), &got); err != nil {
		t.Fatalf("not JSON: %q", down.Out)
	}
	eq(t, "healthy", got["healthy"], any(false))
	eq(t, "compute", got["compute"], any("on"))
	eq(t, "backend", got["computeBackend"], any("hosts"))
	eq(t, "stderr", down.Err, "")
}

func TestConfig(t *testing.T) {
	tt := newTester(t)
	path := tt.install(defaultEnv)
	list := tt.run([]string{"config", "list"}, opts{})
	contains(t, "list", list.Out, "KANTEL_SMTP_PASSWORD  (set)")
	lacks(t, "list", list.Out, "hunter2")

	set := tt.run([]string{"config", "set", "KANTEL_PUBLIC_URL=https://kantel.example.com", "KANTEL_GATEWAY_PORT=58200"}, opts{})
	eq(t, "set exit", set.Code, 0)
	contains(t, "set note", set.Err, "kantel-admin apply")
	eq(t, "set file", tt.read(path),
		"KANTEL_GATEWAY_PORT=58200\nKANTEL_SMTP_PASSWORD=hunter2\nKANTEL_PUBLIC_URL=https://kantel.example.com\n")

	secret := tt.run([]string{"config", "set", "KANTEL_SMTP_PASSWORD=s3cret$x", "--json"}, opts{})
	lacks(t, "secret json", secret.Out, "s3cret")
	contains(t, "secret json", secret.Out, `"KANTEL_SMTP_PASSWORD": "(set)"`)
	contains(t, "secret file", tt.read(path), "KANTEL_SMTP_PASSWORD='s3cret$x'")

	unset := tt.run([]string{"config", "unset", "KANTEL_SMTP_PASSWORD", "--json"}, opts{})
	lacks(t, "unset file", tt.read(path), "SMTP")
	eq(t, "unset json", unset.Out, "{\n  \"path\": \""+path+"\",\n  \"changed\": {\n    \"KANTEL_SMTP_PASSWORD\": null\n  }\n}\n")

	bad := tt.run([]string{"config", "set", "lower=1"}, opts{})
	eq(t, "bad exit", bad.Code, 2)
	contains(t, "bad", bad.Err, "Usage: kantel-admin config set <KEY=value>… [flags]")
	eq(t, "line break", tt.run([]string{"config", "set", "A=x\ny"}, opts{}).Code, 2)
	eq(t, "nothing to set", tt.run([]string{"config", "set"}, opts{}).Code, 2)
}

func TestComputeEnableAndApply(t *testing.T) {
	tt := newTester(t)
	path := tt.install("KANTEL_COMPUTE=experimental\nKANTEL_COMPUTE_BACKEND=stub\nKANTEL_GATEWAY_PORT=58123\n")
	done := tt.run([]string{"compute", "enable", "--hosts", "--public-url", "kantel.example.com/", "--apply"}, opts{})
	eq(t, "exit", done.Code, 0)
	eq(t, "file", tt.read(path), "KANTEL_GATEWAY_PORT=58123\nKANTEL_PUBLIC_URL=https://kantel.example.com\n")
	eq(t, "spawned", len(done.Spawned), 1)
	eq(t, "docker", done.Spawned[0].Command, "docker")
	eq(t, "up", strings.Join(done.Spawned[0].Args[3:], " "), "up -d --wait")
	eq(t, "not captured", done.Spawned[0].Capture, false)

	failed := tt.run([]string{"apply"}, opts{ran: func(spawned) (Ran, error) { return Ran{Code: 1}, nil }})
	eq(t, "failed exit", failed.Code, 1)
	contains(t, "failed", failed.Err, "the stack didn't start")
}

func TestBootstrapKey(t *testing.T) {
	tt := newTester(t)
	tt.install(defaultEnv)
	r := tt.run([]string{"bootstrap-key"}, opts{ran: func(spawned) (Ran, error) {
		return Ran{Stdout: `{"apiKey":"ksk_operator","computeKey":"ksk_compute"}`}, nil
	}})
	eq(t, "key", strings.TrimSpace(r.Out), "ksk_compute")
	eq(t, "exec", strings.Join(r.Spawned[0].Args[3:], "|"), "exec|-T|gateway|sh|-c|cat /var/lib/*/bootstrap.json")
	asJSON := tt.run([]string{"bootstrap-key", "--json"}, opts{ran: func(spawned) (Ran, error) {
		return Ran{Stdout: `{"computeKey":"ksk_compute"}`}, nil
	}})
	eq(t, "json", asJSON.Out, "{\n  \"key\": \"ksk_compute\"\n}\n")

	// --save checks it and writes kantel's config with the local URL.
	saved := tt.run([]string{"bootstrap-key", "--save"}, opts{
		routes: routes{"GET http://127.0.0.1:58123/v1/whoami": func(call) any {
			return map[string]any{"accountId": "acc_1", "accounts": []any{}, "superAdmin": true, "mode": "selfhosted"}
		}},
		ran: func(spawned) (Ran, error) { return Ran{Stdout: `{"computeKey":"ksk_compute"}`}, nil },
	})
	eq(t, "save exit", saved.Code, 0)
	eq(t, "bearer", saved.Calls[0].Auth, "Bearer ksk_compute")
	contains(t, "saved", saved.Out, "Saved the bootstrap key for http://127.0.0.1:58123")
	stored, err := cli.ReadStored(tt.configDir)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "url", stored.URL, "http://127.0.0.1:58123/v1")
	eq(t, "apiKey", stored.APIKey, "ksk_compute")

	// It says to upgrade when there is no key.
	none := tt.run([]string{"bootstrap-key"}, opts{ran: func(spawned) (Ran, error) { return Ran{Stdout: "{}"}, nil }})
	eq(t, "none exit", none.Code, 1)
	contains(t, "none", none.Err, "kantel-admin upgrade")
}

func TestHostList(t *testing.T) {
	tt := newTester(t)
	r := tt.run([]string{"host", "list"}, opts{routes: routes{
		"GET /v1/admin/hosts": func(call) any { return map[string]any{"items": []any{host(nil)}} },
	}})
	eq(t, "exit", r.Code, 0)
	eq(t, "bearer", r.Calls[0].Auth, "Bearer ksk_admin")
	if !regexp.MustCompile(`host_6t5r4e\s+builder-1\s+online\s+0\.4\.0 \(0\.5\.0 out\)\s+microvm,isolate\s+3`).MatchString(r.Out) {
		t.Errorf("table: %q", r.Out)
	}

	empty := tt.run([]string{"host", "list"}, opts{routes: routes{
		"GET /v1/admin/hosts": func(call) any { return map[string]any{"items": []any{}} },
	}})
	contains(t, "empty", empty.Out, "kantel-admin host add")

	forbidden := tt.run([]string{"host", "list"}, opts{routes: routes{
		"GET /v1/admin/hosts": func(call) any { return kantelError(403, "forbidden", "needs hosts:admin") },
	}})
	eq(t, "forbidden exit", forbidden.Code, 1)
	contains(t, "forbidden", forbidden.Err, "Host commands need a key with hosts:admin")

	// Without --url or KANTEL_URL, the local gateway: never kantel's hosted default.
	local := tt.run([]string{"host", "list"}, opts{env: cli.Env{"KANTEL_API_KEY": "k", "KANTEL_GATEWAY_PORT": "58124"},
		routes: routes{"GET http://127.0.0.1:58124/v1/admin/hosts": func(call) any { return map[string]any{"items": []any{}} }}})
	eq(t, "local exit", local.Code, 0)

	info := tt.run([]string{"host", "info", "host_6t5r4e"}, opts{routes: routes{
		"GET /v1/admin/hosts/host_6t5r4e": func(call) any { return host(nil) },
	}})
	contains(t, "info", info.Out, "machine    linux x86_64")
	contains(t, "info", info.Out, "labels     zone=ams")
	contains(t, "info", info.Out, "joined     2026-11-01 00:00 UTC")
	missing := tt.run([]string{"host", "info"}, opts{})
	eq(t, "missing id", missing.Code, 2)
	contains(t, "missing id", missing.Err, "host info needs <hostId>\nUsage: kantel-admin host info <hostId> [flags]")
}

func TestHostAdd(t *testing.T) {
	tt := newTester(t)
	token := map[string]any{
		"id": "hjt_1", "token": "kth_secret", "expiresAt": time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC).UnixMilli(),
		"command": "curl -fsSL " + HostInstallerURL + " | sudo sh -s -- --url https://kantel.test --token kth_secret",
	}
	r := tt.run([]string{"host", "add", "--name", "b2", "--label", "zone=ams", "--expires-minutes", "30"},
		opts{routes: routes{"POST /v1/admin/hosts/join-tokens": func(call) any { return token }}})
	eq(t, "body", jsonOf(t, r.Calls[0].Body), `{"expiresInMinutes":30,"labels":{"zone":"ams"},"name":"b2"}`)
	contains(t, "command", r.Out, "  "+token["command"].(string))
	contains(t, "expiry", r.Out, "before 2026-11-03 12:00 UTC:")
	eq(t, "bad label", tt.run([]string{"host", "add", "--label", "=x"}, opts{}).Code, 2)
	eq(t, "bad minutes", tt.run([]string{"host", "add", "--expires-minutes", "soon"}, opts{}).Code, 2)

	// --ssh runs the command on the machine without echoing the token.
	sshToken := map[string]any{"id": "hjt_1", "token": "kth_secret", "command": "sudo sh install --token kth_secret", "expiresAt": 0}
	r = tt.run([]string{"host", "add", "--ssh", "root@b2"},
		opts{routes: routes{"POST /v1/admin/hosts/join-tokens": func(call) any { return sshToken }}})
	eq(t, "ssh exit", r.Code, 0)
	eq(t, "ssh spawned", len(r.Spawned), 1)
	eq(t, "ssh", r.Spawned[0].Command+" "+strings.Join(r.Spawned[0].Args, "|"), "ssh -t|root@b2|sudo sh install --token kth_secret")
	if r.Spawned[0].Input != nil {
		t.Error("ssh got input")
	}
	lacks(t, "ssh note", r.Err, "kth_secret")
	contains(t, "ssh note", r.Err, "it has joined")
}

func TestHostJoinAndRun(t *testing.T) {
	tt := newTester(t)
	notRoot := tt.run([]string{"host", "join", "--url", "kantel.test", "--token", "kth_x"}, opts{})
	eq(t, "not root exit", notRoot.Code, 1)
	contains(t, "not root", notRoot.Err, "needs root")
	eq(t, "needs both", tt.run([]string{"host", "join", "--token", "kth_x"}, opts{root: true}).Code, 2)

	joined := tt.run([]string{"host", "join", "--url", "kantel.test", "--token", "kth_x", "--", "--tiers", "isolate"},
		opts{root: true, routes: routes{"GET " + HostInstallerURL: func(call) any { return "echo install.sh\n" }}})
	eq(t, "joined exit", joined.Code, 0)
	u, _ := url.Parse(HostInstallerURL)
	eq(t, "downloaded", joined.Calls[0].Path, u.Path)
	eq(t, "spawned", len(joined.Spawned), 1)
	eq(t, "args", joined.Spawned[0].Command+" "+strings.Join(joined.Spawned[0].Args, " "),
		"sh -s -- --url https://kantel.test --token kth_x --tiers isolate")
	eq(t, "input", *joined.Spawned[0].Input, "echo install.sh\n")
	lacks(t, "note", joined.Err, "kth_x")

	run := tt.run([]string{"host", "run", "--", "doctor"}, opts{})
	eq(t, "run", run.Spawned[0].Command+" "+strings.Join(run.Spawned[0].Args, " "), "kantel-host doctor")
	if run.Spawned[0].Input != nil || run.Spawned[0].Capture {
		t.Error("kantel-host's stdio isn't ours")
	}
	eq(t, "run needs a command", tt.run([]string{"host", "run"}, opts{}).Code, 2)

	mac := tt.run([]string{"host", "run", "--", "status"}, opts{platform: "darwin"})
	eq(t, "mac exit", mac.Code, 1)
	contains(t, "mac", mac.Err, "runs on Linux")

	code := tt.run([]string{"host", "run", "--", "status"}, opts{ran: func(spawned) (Ran, error) { return Ran{Code: 3}, nil }})
	eq(t, "kantel-host's own exit code", code.Code, 3)
}

func TestHostDrainUpdateRevoke(t *testing.T) {
	tt := newTester(t)
	var calls []string
	r := routes{
		"PATCH /v1/admin/hosts/host_6t5r4e": func(c call) any {
			calls = append(calls, "PATCH "+jsonOf(t, c.Body))
			state := "online"
			if c.Body.(map[string]any)["draining"] == true {
				state = "draining"
			}
			return host(map[string]any{"state": state})
		},
		"DELETE /v1/admin/hosts/host_6t5r4e": func(c call) any {
			calls = append(calls, "DELETE "+jsonOf(t, c.Body))
			return host(map[string]any{"state": "revoked"})
		},
		"POST /v1/admin/hosts/host_6t5r4e/update": func(call) any {
			return host(map[string]any{"updating": map[string]any{"version": "0.5.0", "requestedAt": 1}})
		},
		"POST /v1/admin/hosts/check-for-updates": func(call) any {
			return map[string]any{"checked": false, "latestVersion": "0.5.0"}
		},
	}
	out := func(argv ...string) string { return strings.TrimSpace(tt.run(argv, opts{routes: r}).Out) }
	eq(t, "drain", out("host", "drain", "host_6t5r4e"), "host_6t5r4e draining")
	eq(t, "drain --off", out("host", "drain", "host_6t5r4e", "--off"), "host_6t5r4e online")
	// --undo, its old name, still works.
	eq(t, "drain --undo", out("host", "drain", "host_6t5r4e", "--undo"), "host_6t5r4e online")
	unsure := tt.run([]string{"host", "revoke", "host_6t5r4e"}, opts{routes: r})
	eq(t, "unsure exit", unsure.Code, 2)
	contains(t, "unsure", unsure.Err, "kantel-admin host revoke host_6t5r4e --yes")
	eq(t, "revoke", out("host", "revoke", "host_6t5r4e", "--yes"), "host_6t5r4e revoked")
	eq(t, "calls", strings.Join(calls, ", "), `PATCH {"draining":true}, PATCH {"draining":false}, PATCH {"draining":false}, DELETE null`)

	if got := out("host", "update", "host_6t5r4e"); got != "host_6t5r4e updating to 0.5.0" {
		// The route's path is the generated client's; say what it called if it differs.
		t.Errorf("update: %q (%v)", got, tt.run([]string{"host", "update", "host_6t5r4e"}, opts{routes: r}).Err)
	}
	if got := out("host", "check-for-updates"); got != "checked in the last 30 seconds; latest kantel-host: 0.5.0" {
		t.Errorf("check-for-updates: %q (%v)", got, tt.run([]string{"host", "check-for-updates"}, opts{routes: r}).Err)
	}
}

func TestErrors(t *testing.T) {
	tt := newTester(t)
	// 4, as kantel: it needs a credential.
	r := tt.run([]string{"host", "list"}, opts{env: cli.Env{}})
	eq(t, "no key exit", r.Code, 4)
	contains(t, "no key", r.Err, "bootstrap-key --save")
	eq(t, "no calls", len(r.Calls), 0)
	r = tt.run([]string{"host", "list", "--json"}, opts{env: cli.Env{}})
	eq(t, "no key json", r.Err, `{"error":{"code":"unauthenticated","message":"this needs a key with hosts:admin: kantel-admin bootstrap-key --save, or KANTEL_URL and KANTEL_API_KEY","exitCode":4}}`+"\n")

	// With --json a failure is JSON, with Kantel's code and a hint.
	r = tt.run([]string{"host", "list", "--json"}, opts{routes: routes{
		"GET /v1/admin/hosts": func(call) any { return kantelError(403, "forbidden", "This key lacks hosts:admin") },
	}})
	eq(t, "forbidden exit", r.Code, 1)
	eq(t, "stdout", r.Out, "")
	eq(t, "stderr", r.Err, `{"error":{"code":"forbidden","message":"This key lacks hosts:admin","hint":"Host commands need a key with hosts:admin.","status":403,"exitCode":1}}`+"\n")
}

func TestHelp(t *testing.T) {
	tt := newTester(t)
	help := tt.run(nil, opts{})
	for _, name := range []string{"install", "upgrade", "status", "compute enable", "bootstrap-key", "host add", "host join", "host revoke"} {
		contains(t, "help", help.Out, name)
	}
	contains(t, "help host join", tt.run([]string{"help", "host", "join"}, opts{}).Out, "Usage: kantel-admin host join")
	contains(t, "host add --help", tt.run([]string{"host", "add", "--help"}, opts{}).Out, "--ssh <user@machine>")
	eq(t, "unknown", tt.run([]string{"nope"}, opts{}).Code, 2)
	typo := tt.run([]string{"hots", "list"}, opts{})
	eq(t, "typo exit", typo.Code, 2)
	contains(t, "typo", typo.Err, "Did you mean kantel-admin host list?")
	contains(t, "flag typo", tt.run([]string{"host", "add", "--nmae", "x"}, opts{}).Err, "Did you mean --name?")
	contains(t, "group", tt.run([]string{"host"}, opts{}).Out, "kantel-admin host: The machines that run sandboxes.")
}

func TestVersion(t *testing.T) {
	tt := newTester(t)
	for _, argv := range [][]string{{"--version"}, {"-V"}, {"version"}} {
		eq(t, strings.Join(argv, " "), strings.TrimSpace(tt.run(argv, opts{}).Out), "0.0.0")
	}
	eq(t, "version --json", tt.run([]string{"version", "--json"}, opts{}).Out, "{\n  \"version\": \"0.0.0\"\n}\n")
}

func TestHelpJSONAndExamples(t *testing.T) {
	tt := newTester(t)
	var schema cli.Schema
	if err := json.Unmarshal([]byte(tt.run([]string{"help", "--json"}, opts{}).Out), &schema); err != nil {
		t.Fatal(err)
	}
	eq(t, "program", schema.Program, "kantel-admin")
	eq(t, "exit 4", schema.ExitCodes["4"] != "", true)
	// Every example names a real command and real flags.
	for _, c := range Program(System{}).Commands() {
		for _, e := range c.Examples {
			argv := strings.Fields(strings.TrimPrefix(e.Line, "kantel-admin "))
			if k := indexOf(argv, "--"); k >= 0 {
				argv = append(append(append([]string{}, argv[:k]...), "--help"), argv[k:]...)
			} else {
				argv = append(argv, "--help")
			}
			r := tt.run(argv, opts{})
			if r.Code != 0 || !strings.Contains(r.Out, "Usage: kantel-admin "+c.Name) {
				t.Errorf("example %q: exit %d, %s", e.Line, r.Code, r.Err)
			}
		}
	}
}

func TestCompletion(t *testing.T) {
	tt := newTester(t)
	complete := func(words ...string) string {
		return tt.run(append([]string{"__complete", "--"}, words...), opts{}).Out
	}
	contains(t, "script", tt.run([]string{"completion", "fish"}, opts{}).Out, "kantel-admin __complete --")
	eq(t, "subcommand", complete("host", "dr"), "drain\tStop placing new sandboxes on a host (--off to take them again)\n")
	eq(t, "flag", complete("host", "drain", "--o"), "--off\tTake new sandboxes again\n")
	// A flag's value before the command isn't a command word.
	if got := complete("--url", "https://self.test", "host", "dr"); !strings.HasPrefix(got, "drain\t") {
		t.Errorf("after --url: %q", got)
	}
	eq(t, "groups", complete("co"), "completion\tThe script that completes kantel-admin's commands and flags in bash, zsh or fish\n"+
		"compute\tRun sandboxes on your own hosts\nconfig\tThe stack's settings\n")
}

func TestFindsTheCommandAfterFlagsThatTakeAValue(t *testing.T) {
	tt := newTester(t)
	tt.install("KANTEL_COMPUTE=experimental\n")
	r := tt.run([]string{"--home", filepath.Join(tt.home, ".kantel"), "--json", "config", "list"}, opts{})
	eq(t, "exit", r.Code, 0)
	eq(t, "json", r.Out, "{\n  \"KANTEL_COMPUTE\": \"experimental\"\n}\n")
}

func TestColourAtATerminalOnly(t *testing.T) {
	tt := newTester(t)
	list := routes{"GET /v1/admin/hosts": func(call) any { return map[string]any{"items": []any{host(nil)}} }}
	r := tt.run([]string{"host", "list"}, opts{routes: list, tty: true})
	contains(t, "state", r.Out, "\x1b[32monline\x1b[39m")
	plain := tt.run([]string{"host", "list"}, opts{routes: list})
	lacks(t, "plain", plain.Out, "\x1b[")
	eq(t, "same text", cli.Plain(r.Out), plain.Out)
}

func indexOf(words []string, w string) int {
	for i, x := range words {
		if x == w {
			return i
		}
	}
	return -1
}

func TestEnvValuesSurviveCompose(t *testing.T) {
	for _, value := range []string{"plain", "p$a", "a #b", `it's "x" $y \z`, "", "https://k.example/v1?a=b&c=d"} {
		text := UpdateEnvFile("", Changes{{Key: "K", Value: &value}})
		got, _ := ParseEnvFile(text).Get("K")
		if got != value {
			t.Errorf("%q: written %q, read back %q", value, text, got)
		}
		if strings.Contains(value, "$") && !strings.Contains(text, "'") && !strings.Contains(text, "$$") {
			t.Errorf("%q: $ left for Compose to interpolate: %q", value, text)
		}
	}
}
