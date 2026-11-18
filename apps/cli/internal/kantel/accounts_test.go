package kantel

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

var (
	personalAccount = map[string]any{"id": "acc_p_1", "kind": "personal", "name": "Tom", "role": "owner", "defaultVisibility": "private", "createdAt": 1}
	acmeAccount     = map[string]any{"id": "acc_org", "kind": "organisation", "name": "Acme", "role": "admin",
		"defaultVisibility": "organisation", "personalTokens": "allowed", "createdAt": 2}
	me = map[string]any{
		"user":          map[string]any{"id": "usr_1", "name": "Tom", "email": "tom@example.com"},
		"personalToken": map[string]any{"id": "pat_1", "name": "laptop", "expiresAt": time.Now().UnixMilli() + 86_400_000},
		"accountId":     "acc_p_1", "accounts": []any{personalAccount, acmeAccount}, "superAdmin": false, "mode": "hosted",
	}
)

func accountRoutes(more routes) routes {
	r := routes{
		"GET /v1/whoami":           func(call) any { return me },
		"GET /v1/accounts":         func(call) any { return map[string]any{"items": []any{personalAccount, acmeAccount}} },
		"GET /v1/accounts/acc_org": func(call) any { return acmeAccount },
		"GET /v1/accounts/acc_p_1": func(call) any { return personalAccount },
	}
	for k, v := range more {
		r[k] = v
	}
	return r
}

func readConfig(t *testing.T, dir string) cli.Stored {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var s cli.Stored
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

// fakeOnly is an environment that names the fake Kantel and nothing else: the key comes from the saved config.
func fakeOnly() cli.Env { return cli.Env{"KANTEL_URL": "$FAKE"} }

func TestOrgUse(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"url":"https://kantel.test/v1","apiKey":"kpt_x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	used := run(t, []string{"org", "use", "acme"}, opts{env: fakeOnly(), configDir: dir, routes: accountRoutes(nil)})
	eq(t, "exit", used.Code, 0)
	contains(t, "out", used.Stdout, "Commands act in Acme (acc_org) from now on.")
	saved := readConfig(t, dir)
	eq(t, "key kept", saved.APIKey, "kpt_x")
	eq(t, "url kept", saved.URL, "https://kantel.test/v1")
	eq(t, "account", saved.Account, "acc_org")
	if info, _ := os.Stat(filepath.Join(dir, "config.json")); info.Mode().Perm() != 0o600 {
		t.Errorf("config mode %v", info.Mode().Perm())
	}

	r := accountRoutes(routes{"GET /v1/sandboxes": func(call) any { return map[string]any{"items": []any{}} }})
	listed := run(t, []string{"org", "list"}, opts{env: fakeOnly(), configDir: dir, routes: r})
	matches(t, "marked", listed.Stdout, `\*\s+acc_org`)
	there := run(t, []string{"list"}, opts{env: fakeOnly(), configDir: dir, routes: r})
	eq(t, "account", strings.Join(last(there).Query["account"], ""), "acc_org")
	personal := run(t, []string{"list", "--account", "personal"}, opts{env: fakeOnly(), configDir: dir, routes: r})
	eq(t, "personal", strings.Join(last(personal).Query["account"], ""), "acc_p_1")
	unknown := run(t, []string{"list", "--account", "Nope"}, opts{env: fakeOnly(), configDir: dir, routes: r})
	eq(t, "unknown exit", unknown.Code, 1)
	contains(t, "unknown", unknown.Stderr, `you have no account called "Nope"`)

	byID := run(t, []string{"org", "use", "acc_org", "--json"}, opts{env: cli.Env{"KANTEL_URL": "$FAKE", "KANTEL_ACCOUNT": "Tom"}, configDir: dir, routes: accountRoutes(nil)})
	eq(t, "by id", byID.Code, 0)
	contains(t, "json", byID.Stdout, `"id": "acc_org"`)
	contains(t, "env note", byID.Stderr, "KANTEL_ACCOUNT is set in your environment")

	bare := run(t, []string{"org", "use"}, opts{env: fakeOnly(), configDir: dir})
	eq(t, "bare exit", bare.Code, 2)
	cleared := run(t, []string{"org", "use", "--clear"}, opts{env: fakeOnly(), configDir: dir, routes: accountRoutes(nil)})
	eq(t, "cleared exit", cleared.Code, 0)
	eq(t, "cleared calls", len(cleared.Calls), 0)
	after := readConfig(t, dir)
	eq(t, "cleared", after.Account, "")
	eq(t, "key still", after.APIKey, "kpt_x")
}

func TestAccountNameLookedUpOnlyWhereItActs(t *testing.T) {
	env := func() cli.Env {
		return cli.Env{"KANTEL_URL": "$FAKE", "KANTEL_API_KEY": "ksk_test", "KANTEL_ACCOUNT": "Gone"}
	}
	r := accountRoutes(routes{
		"GET /v1/sandboxes":       func(call) any { return map[string]any{"items": []any{}} },
		"GET /v1/personal-tokens": func(call) any { return map[string]any{"items": []any{}} },
	})
	eq(t, "every account", run(t, []string{"list", "--every-account"}, opts{env: env(), routes: r}).Code, 0)
	eq(t, "token list", run(t, []string{"token", "list"}, opts{env: env(), routes: r}).Code, 0)
	eq(t, "whoami", run(t, []string{"whoami"}, opts{env: env(), routes: r}).Code, 0)
	listed := run(t, []string{"org", "list"}, opts{env: env(), routes: r})
	eq(t, "org list", listed.Code, 0)
	contains(t, "org list", listed.Stdout, "kantel acts in Gone, which you can't reach")
	eq(t, "org use", run(t, []string{"org", "use", "personal"}, opts{env: env(), routes: r}).Code, 0)
	there := run(t, []string{"list"}, opts{env: env(), routes: r})
	eq(t, "list", there.Code, 1)
	contains(t, "list", there.Stderr, `you have no account called "Gone"`)
}

func TestOrganisationSettingsMembersAndInvites(t *testing.T) {
	env := func() cli.Env {
		return cli.Env{"KANTEL_URL": "$FAKE", "KANTEL_API_KEY": "ksk_test", "KANTEL_ACCOUNT": "Acme"}
	}
	r := accountRoutes(routes{
		"PATCH /v1/accounts/acc_org": func(c call) any {
			out := with(acmeAccount)
			for k, v := range c.Body {
				out[k] = v
			}
			return out
		},
		"GET /v1/accounts/acc_org/members": func(call) any {
			return map[string]any{"items": []any{
				map[string]any{"userId": "usr_1", "name": "Tom", "email": "tom@example.com", "role": "admin", "joinedAt": 1},
				map[string]any{"userId": "usr_2", "name": "Ann", "email": "ann@example.com", "role": "member", "joinedAt": 2},
			}}
		},
		"PATCH /v1/accounts/acc_org/members/usr_2": func(call) any {
			return map[string]any{"userId": "usr_2", "name": "Ann", "role": "admin", "joinedAt": 2}
		},
		"DELETE /v1/accounts/acc_org/members/usr_2": func(call) any { return nil },
		"POST /v1/accounts/acc_org/invites": func(call) any {
			return map[string]any{"id": "inv_1", "accountId": "acc_org", "role": "member", "email": "bob@example.com",
				"code": "kji_code", "emailed": true, "expiresAt": time.Now().UnixMilli() + 3_600_000, "createdAt": 1}
		},
		"GET /v1/accounts/acc_org/usage": func(call) any {
			return map[string]any{"accountId": "acc_org", "since": 1, "running": 2, "runningSeconds": 3700,
				"cost": map[string]any{"currency": "USD", "total": 1.5}, "limits": map[string]any{"concurrentSandboxes": 10}}
		},
	})
	set := run(t, []string{"org", "set", "--personal-tokens", "blocked"}, opts{env: env(), routes: r})
	eq(t, "set exit", set.Code, 0)
	jsonEq(t, "set body", last(set).Body, `{"personalTokens":"blocked"}`)
	matches(t, "set", set.Stdout, `personal tokens\s+blocked`)
	eq(t, "nothing to set", run(t, []string{"org", "set"}, opts{env: env(), routes: r}).Code, 2)

	shown := run(t, []string{"org", "show"}, opts{env: env(), routes: r})
	matches(t, "show", shown.Stdout, `new sandboxes\s+shared with the organisation`)
	usage := run(t, []string{"org", "usage", "--days", "7"}, opts{env: env(), routes: r})
	eq(t, "usage exit", usage.Code, 0)
	matches(t, "usage", usage.Stdout, `running time\s+1h 1m`)
	matches(t, "limit", usage.Stdout, `limit concurrentSandboxes\s+10`)
	since := last(usage).Query["since"]
	if len(since) != 1 || since[0] == "" {
		t.Errorf("usage since: %v", since)
	}

	members := run(t, []string{"member", "list"}, opts{env: env(), routes: r})
	matches(t, "members", members.Stdout, `usr_2\s+Ann\s+ann@example.com\s+member`)
	promoted := run(t, []string{"member", "role", "ann@example.com", "admin"}, opts{env: env(), routes: r})
	eq(t, "role exit", promoted.Code, 0)
	jsonEq(t, "role body", last(promoted).Body, `{"role":"admin"}`)
	eq(t, "role out", promoted.Stdout, "Ann is an admin of Acme.\n")
	badRole := run(t, []string{"member", "role", "usr_2", "boss"}, opts{env: env(), routes: r})
	eq(t, "bad role", badRole.Code, 2)
	removed := run(t, []string{"member", "rm", "usr_2"}, opts{env: env(), routes: r})
	eq(t, "rm", last(removed).Method, "DELETE")
	eq(t, "rm out", removed.Stdout, "Removed usr_2 from Acme.\n")

	invited := run(t, []string{"invite", "create", "--email", "bob@example.com"}, opts{env: env(), routes: r})
	jsonEq(t, "invite body", last(invited).Body, `{"email":"bob@example.com"}`)
	contains(t, "invite", invited.Stdout, "kantel org join kji_code")
	contains(t, "invite", invited.Stdout, "Kantel emailed them a link to join.")
	contains(t, "invite", invited.Stdout, "Invited bob@example.com to Acme as a member, until ")

	// Leaving and deleting need --yes, and say how to run it.
	leave := run(t, []string{"org", "leave"}, opts{env: env(), routes: r})
	eq(t, "leave exit", leave.Code, 2)
	contains(t, "leave", leave.Stderr, "kantel org leave --account acc_org --yes")
	del := run(t, []string{"org", "delete"}, opts{env: env(), routes: r})
	eq(t, "delete exit", del.Code, 2)
	contains(t, "delete", del.Stderr, "kantel org delete --account acc_org --yes")
}

func TestOrgLeaveAndDeleteForgetTheSavedAccount(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"apiKey":"kpt_x","account":"acc_org"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	r := accountRoutes(routes{
		"DELETE /v1/accounts/acc_org/members/usr_1": func(call) any { return nil },
		"DELETE /v1/accounts/acc_org":               func(call) any { return nil },
	})
	left := run(t, []string{"org", "leave", "--yes"}, opts{env: fakeOnly(), configDir: dir, routes: r})
	eq(t, "leave exit", left.Code, 0)
	eq(t, "leave out", left.Stdout, "You left Acme.\n")
	contains(t, "note", left.Stderr, "kantel: commands act in your default account again.")
	eq(t, "forgotten", readConfig(t, dir).Account, "")
	eq(t, "key kept", readConfig(t, dir).APIKey, "kpt_x")

	// An API key can't leave.
	keyed := accountRoutes(routes{"GET /v1/whoami": func(call) any {
		return with(me, "apiKey", map[string]any{"id": "key_1", "name": "ci", "scopes": []any{}})
	}})
	refused := run(t, []string{"org", "leave", "--yes", "--account", "acc_org"}, opts{routes: keyed})
	eq(t, "key exit", refused.Code, 1)
	contains(t, "key", refused.Stderr, "an API key can't leave an organisation")

	deleted := run(t, []string{"org", "delete", "--yes", "--account", "acc_org", "--json"}, opts{routes: r})
	eq(t, "delete exit", deleted.Code, 0)
	contains(t, "delete json", deleted.Stdout, `"deleted": "acc_org"`)
}

func TestOrganisationCommandsNeedAnOrganisation(t *testing.T) {
	r := run(t, []string{"member", "list"}, opts{routes: accountRoutes(nil)})
	eq(t, "exit", r.Code, 2)
	contains(t, "err", r.Stderr, "kantel org use <name>")
}

func TestOrgCreateAndJoinWithUse(t *testing.T) {
	dir := t.TempDir()
	r := accountRoutes(routes{
		"POST /v1/accounts":      func(c call) any { return with(acmeAccount, "name", c.Body["name"]) },
		"POST /v1/accounts/join": func(call) any { return acmeAccount },
	})
	made := run(t, []string{"org", "create", "Acme", "--visibility", "private", "--use"}, opts{configDir: dir, routes: r})
	eq(t, "exit", made.Code, 0)
	jsonEq(t, "body", last(made).Body, `{"name":"Acme","defaultVisibility":"private"}`)
	eq(t, "out", made.Stdout, "Created Acme (acc_org). Commands act in it from now on.\n")
	eq(t, "saved", readConfig(t, dir).Account, "acc_org")
	plain := run(t, []string{"org", "create", "Acme"}, opts{routes: r})
	eq(t, "plain out", plain.Stdout, "Created Acme (acc_org). Act in it with: kantel org use acc_org\n")
	bad := run(t, []string{"org", "create", "Acme", "--visibility", "public"}, opts{routes: r})
	eq(t, "bad", bad.Code, 2)
	eq(t, "bad calls", len(bad.Calls), 0)
}

func TestPersonalTokensAndKeys(t *testing.T) {
	r := accountRoutes(routes{
		"POST /v1/personal-tokens": func(c call) any {
			token := map[string]any{"id": "pat_2", "name": "ci", "prefix": "kpt_abcd", "createdAt": 1, "expiresAt": time.Now().UnixMilli() + 86_400_000}
			for k, v := range c.Body {
				token[k] = v
			}
			return map[string]any{"token": token, "secret": "kpt_secret"}
		},
		"GET /v1/personal-tokens": func(call) any {
			return map[string]any{"items": []any{map[string]any{"id": "pat_2", "name": "ci", "prefix": "kpt_abcd",
				"accounts": []any{"acc_org"}, "createdAt": 1, "expiresAt": time.Now().UnixMilli() + 86_400_000}}}
		},
		"DELETE /v1/personal-tokens/pat_2": func(call) any {
			return map[string]any{"id": "pat_2", "name": "ci", "prefix": "kpt_abcd", "createdAt": 1, "expiresAt": 2, "revokedAt": 3}
		},
		"GET /v1/api-keys": func(call) any {
			return map[string]any{"items": []any{map[string]any{"id": "key_1", "name": "agent", "prefix": "ksk_ab", "accountId": "acc_p_1",
				"scopes": []any{"sandboxes:read", "exec"}, "createdAt": 1, "createdBy": map[string]any{"kind": "user", "id": "usr_1"}}}}
		},
		"POST /v1/api-keys": func(c call) any {
			return map[string]any{"secret": "ksk_secret", "key": map[string]any{"id": "key_2", "name": c.Body["name"], "prefix": "ksk_cd",
				"accountId": "acc_p_1", "scopes": []any{"sandboxes:read"}, "createdAt": 1, "createdBy": map[string]any{"kind": "user", "id": "usr_1"}}}
		},
	})
	made := run(t, []string{"token", "create", "ci", "--only", "Acme", "--preset", "read-only"}, opts{routes: r})
	eq(t, "exit", made.Code, 0)
	jsonEq(t, "body", last(made).Body, `{"name":"ci","preset":"read-only","accounts":["acc_org"]}`)
	contains(t, "secret", made.Stdout, "  kpt_secret\n")
	contains(t, "once", made.Stdout, "Store it now: it isn't shown again. Give it to a script as KANTEL_API_KEY.")
	listed := run(t, []string{"token", "list"}, opts{routes: r})
	matches(t, "list", listed.Stdout, `pat_2\s+ci\s+active\s+as your role allows\s+acc_org`)
	revoked := run(t, []string{"token", "revoke", "pat_2"}, opts{routes: r})
	eq(t, "revoked", revoked.Stdout, "Revoked pat_2 (ci).\n")

	keys := run(t, []string{"key", "ls"}, opts{routes: r})
	matches(t, "keys", keys.Stdout, `key_1\s+agent\s+ksk_ab\s+active\s+sandboxes:read,exec`)
	key := run(t, []string{"key", "create", "agent", "--preset", "agent", "--expires-days", "30", "--sandbox", "sbx_1"}, opts{routes: r})
	eq(t, "key exit", key.Code, 0)
	jsonEq(t, "key body", last(key).Body, `{"name":"agent","preset":"agent","expiresInDays":30,"sandboxIds":["sbx_1"]}`)
	eq(t, "key out", key.Stdout, "key_2 (agent): sandboxes:read\n\n  ksk_secret\n\nStore it now: it isn't shown again.\n")
	for _, argv := range [][]string{
		{"key", "create", "x", "--preset", "everything"},
		{"key", "create", "x", "--scope", "root"},
		{"key", "create", "x", "--expires-days", "0"},
	} {
		bad := run(t, argv, opts{routes: r})
		eq(t, strings.Join(argv, " "), bad.Code, 2)
		eq(t, strings.Join(argv, " ")+" calls", len(bad.Calls), 0)
	}
}
