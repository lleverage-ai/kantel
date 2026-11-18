package kantel

import (
	"encoding/json"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

func TestHostPrintsAPortsURL(t *testing.T) {
	r := run(t, []string{"host", "sbx_test1", "3000", "--public"}, opts{routes: routes{
		"POST /v1/sandboxes/sbx_test1/ports": func(call) any {
			return map[string]any{"port": 3000, "url": "https://p3000-brave-otter.kantel.test", "public": true, "createdAt": 1}
		},
	}})
	eq(t, "exit", r.Code, 0)
	eq(t, "stdout", r.Stdout, "https://p3000-brave-otter.kantel.test\n")
	eq(t, "body", string(r.Calls[0].Raw), `{"port":3000,"public":true}`)

	r = run(t, []string{"host", "sbx_test1", "web"}, opts{})
	eq(t, "bad port", r.Code, 2)
	contains(t, "bad port", r.Stderr, `port must be a whole number of at least 1, not "web"`)
}

func TestPortListAndHide(t *testing.T) {
	r := run(t, []string{"port", "list", "sbx_test1"}, opts{routes: routes{
		"GET /v1/sandboxes/sbx_test1/ports": func(call) any {
			return map[string]any{"items": []any{map[string]any{"port": 3000, "url": "https://p3000.kantel.test", "public": false, "createdAt": 1}}}
		},
	}})
	eq(t, "exit", r.Code, 0)
	eq(t, "list", r.Stdout, "PORT  URL                        PUBLIC\n3000  https://p3000.kantel.test  no\n")
	r = run(t, []string{"port", "ls", "sbx_test1"}, opts{routes: routes{
		"GET /v1/sandboxes/sbx_test1/ports": func(call) any { return map[string]any{"items": []any{}} },
	}})
	eq(t, "none", r.Stdout, "No exposed ports.\n")

	hide := routes{"DELETE /v1/sandboxes/sbx_test1/ports/3000": func(call) any { return nil }}
	r = run(t, []string{"port", "hide", "sbx_test1", "3000"}, opts{routes: hide})
	eq(t, "hide exit", r.Code, 0)
	eq(t, "hide", r.Stdout, "Port 3000 is hidden.\n")
	r = run(t, []string{"port", "hide", "sbx_test1", "3000", "--json"}, opts{routes: hide})
	eq(t, "hide json", r.Stdout, "{\n  \"hidden\": 3000\n}\n")
}

func TestHelpHidesPortExposeAndHostListMoved(t *testing.T) {
	r := run(t, []string{"help"}, opts{})
	if strings.Contains(r.Stdout, "port expose") || strings.Contains(r.Stdout, "ssh-proxy") {
		t.Error("help shows a hidden command")
	}
	contains(t, "help", r.Stdout, "ssh <id> [-- <command…>]")
	r = run(t, []string{"host", "list"}, opts{})
	eq(t, "moved exit", r.Code, 2)
	contains(t, "moved", r.Stderr, "kantel-admin host list (your own hosts: kantel hosts list)")
	eq(t, "calls", len(r.Calls), 0)
}

func TestDesktopOpensForAPersonOnly(t *testing.T) {
	desktop := routes{"POST /v1/sandboxes/sbx_test1/desktop": func(call) any {
		return map[string]any{"url": "https://desk.kantel.test/#t", "embedUrl": "https://desk.kantel.test/e#t", "expiresAt": 1, "viewOnly": false}
	}}
	person := run(t, []string{"desktop", "sbx_test1"}, opts{routes: desktop, tty: true})
	if !reflect.DeepEqual(person.Opened, []string{"https://desk.kantel.test/#t"}) {
		t.Errorf("person: opened %q", person.Opened)
	}
	script := run(t, []string{"desktop", "sbx_test1"}, opts{routes: desktop})
	eq(t, "script opened", len(script.Opened), 0)
	contains(t, "script", script.Stdout, "https://desk.kantel.test/#t")
	for _, argv := range [][]string{{"desktop", "sbx_test1", "--print"}, {"desktop", "sbx_test1", "--json"}} {
		r := run(t, argv, opts{routes: desktop, tty: true})
		eq(t, strings.Join(argv, " ")+" opened", len(r.Opened), 0)
	}
	r := run(t, []string{"desktop", "sbx_test1"}, opts{routes: desktop, tty: true,
		env: cli.Env{"KANTEL_URL": "$FAKE", "KANTEL_API_KEY": "k", "KANTEL_NO_BROWSER": "1"}})
	eq(t, "KANTEL_NO_BROWSER opened", len(r.Opened), 0)

	r = run(t, []string{"desktop", "sbx_test1", "--view-only", "--ttl", "30", "--print"}, opts{routes: desktop})
	eq(t, "body", string(r.Calls[0].Raw), `{"ttlMinutes":30,"viewOnly":true}`)
}

func TestBrowserPrintsItsViewAndCDPURLs(t *testing.T) {
	r := run(t, []string{"browser", "sbx_test1", "--print"}, opts{routes: routes{
		"POST /v1/sandboxes/sbx_test1/browser": func(call) any {
			return map[string]any{"url": "https://view.kantel.test/#t", "cdpUrl": "wss://cdp.kantel.test/#t",
				"embedUrl": "https://view.kantel.test/e", "expiresAt": 1, "surface": "browser", "viewOnly": false}
		},
	}, tty: true})
	eq(t, "exit", r.Code, 0)
	eq(t, "opened", len(r.Opened), 0)
	eq(t, "stdout", cli.Plain(r.Stdout), "view  https://view.kantel.test/#t\ncdp   wss://cdp.kantel.test/#t\n")
}

// Snapshots.

var savedSnapshot = map[string]any{
	"id": "snap_1", "accountId": "acc_1", "kind": "saved", "name": "checks-warm", "description": "Warm Turbo cache",
	"labels": map[string]any{"git.base": "9540593c"}, "sandboxId": "sbx_test1", "sandboxType": "microvm",
	"state": "ready", "memory": false, "uses": 3,
	"createdAt": time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC).UnixMilli(),
	"takenAt":   time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC).UnixMilli(),
}

func withFields(base map[string]any, fields map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range fields {
		out[k] = v
	}
	return out
}

func paths(calls []call) []string {
	var out []string
	for _, c := range calls {
		out = append(out, c.Path)
	}
	return out
}

func TestSnapshotSaveAndTakeWithLabels(t *testing.T) {
	r := run(t, []string{"snapshot", "save", "sbx_test1", "checks-warm", "--label", "git.base=9540593c", "--label", "node=24"},
		opts{routes: routes{"POST /v1/snapshots": func(call) any { return savedSnapshot }}})
	eq(t, "exit", r.Code, 0)
	eq(t, "body", string(r.Calls[0].Raw), `{"labels":{"git.base":"9540593c","node":"24"},"name":"checks-warm","sandboxId":"sbx_test1"}`)
	if r.Calls[0].Key == "" {
		t.Error("no Idempotency-Key on save")
	}
	eq(t, "out", r.Stdout, "Saved checks-warm (snap_1).\n  Start from it:  kantel sandbox create --from checks-warm\n")

	r = run(t, []string{"snapshot", "take", "sbx_test1", "--label", "git.base=abc"},
		opts{routes: routes{"POST /v1/sandboxes/sbx_test1/snapshots": func(call) any { return savedSnapshot }}})
	eq(t, "take body", string(r.Calls[0].Raw), `{"labels":{"git.base":"abc"}}`)
	eq(t, "take out", r.Stdout, "snap_1 ready\n")

	r = run(t, []string{"snapshot", "save", "sbx_test1", "x", "--label", "git.base"}, opts{})
	eq(t, "bad label", r.Code, 2)
	eq(t, "bad label calls", len(r.Calls), 0)
}

func TestSnapshotSaveMinMemory(t *testing.T) {
	save := routes{"POST /v1/snapshots": func(call) any {
		return map[string]any{"id": "snap_1", "name": "checks", "kind": "saved", "minMemoryMb": 16384}
	}}
	r := run(t, []string{"snapshot", "save", "sbx_test1", "checks", "--min-memory", "16"}, opts{routes: save})
	eq(t, "exit", r.Code, 0)
	eq(t, "16", r.Calls[0].Body["minMemoryMb"], any(float64(16384)))
	r = run(t, []string{"snapshot", "save", "sbx_test1", "checks", "--replace", "--min-memory", "0"}, opts{routes: save})
	eq(t, "0", r.Calls[0].Body["minMemoryMb"], any(float64(0)))
	eq(t, "replace", r.Calls[0].Body["replace"], any(true))
	r = run(t, []string{"snapshot", "save", "sbx_test1", "checks", "--min-memory", "0.5"}, opts{routes: save})
	eq(t, "0.5", r.Calls[0].Body["minMemoryMb"], any(float64(512)))
	r = run(t, []string{"snapshot", "save", "sbx_test1", "checks"}, opts{routes: save})
	if _, ok := r.Calls[0].Body["minMemoryMb"]; ok {
		t.Error("minMemoryMb sent without --min-memory")
	}
	r = run(t, []string{"snapshot", "save", "sbx_test1", "checks", "--min-memory", "16GB"}, opts{routes: save})
	eq(t, "wrong exit", r.Code, 2)
	eq(t, "wrong calls", len(r.Calls), 0)
	contains(t, "wrong", r.Stderr, `--min-memory is in GB, such as 16 or 0.5, not "16GB"`)
}

func TestSnapshotListByIDOrFlag(t *testing.T) {
	list := routes{"GET /v1/snapshots": func(call) any { return map[string]any{"items": []any{}} }}
	r := run(t, []string{"snapshot", "list", "sbx_test1"}, opts{routes: list})
	eq(t, "exit", r.Code, 0)
	eq(t, "by ID", query(r.Calls[0], "sandboxId"), "sbx_test1")
	eq(t, "none", r.Stdout, "No snapshots.\n")
	r = run(t, []string{"snapshot", "list", "--sandbox", "sbx_test1", "--saved"}, opts{routes: list})
	eq(t, "by flag", query(r.Calls[0], "sandboxId"), "sbx_test1")
	eq(t, "saved", query(r.Calls[0], "kind"), "saved")
	r = run(t, []string{"snapshot", "list", "sbx_test1", "--sandbox", "sbx_other"}, opts{routes: list})
	eq(t, "both", r.Code, 2)
	eq(t, "both calls", len(r.Calls), 0)

	r = run(t, []string{"snapshot", "ls"}, opts{routes: routes{"GET /v1/snapshots": func(call) any {
		return map[string]any{"items": []any{withFields(savedSnapshot, map[string]any{"memory": true, "sizeBytes": 1536 * 1024 * 1024,
			"createdAt": time.Now().Add(-5 * time.Minute).UnixMilli()})}, "nextCursor": "c2"}
	}}})
	eq(t, "table", r.Stdout, "ID      NAME         KIND           STATE  SANDBOX    SIZE     CREATED\n"+
		"snap_1  checks-warm  saved, memory  ready  sbx_test1  1.5 GiB  5m ago\n\nMore: kantel snapshot list --cursor c2\n")
}

func TestSnapshotInfoByIDOrSavedName(t *testing.T) {
	pages := routes{
		"GET /v1/snapshots": func(c call) any {
			if query(c, "cursor") == "" {
				return map[string]any{"items": []any{withFields(savedSnapshot, map[string]any{"id": "snap_0", "name": "other"})}, "nextCursor": "c2"}
			}
			return map[string]any{"items": []any{savedSnapshot}}
		},
		"GET /v1/snapshots/snap_1": func(call) any { return savedSnapshot },
	}
	r := run(t, []string{"snapshot", "info", "checks-warm"}, opts{routes: pages})
	eq(t, "exit", r.Code, 0)
	eq(t, "paths", strings.Join(paths(r.Calls), " "), "/v1/snapshots /v1/snapshots /v1/snapshots/snap_1")
	eq(t, "kind", query(r.Calls[0], "kind"), "saved")
	for _, line := range []string{`(?m)^labels\s+git\.base=9540593c$`, `(?m)^description\s+Warm Turbo cache$`,
		`(?m)^taken\s+2026-11-06 09:00`, `(?m)^saved\s+2026-11-06 12:00`, `(?m)^uses\s+3$`, `(?m)^machine\s+microvm$`} {
		if !regexp.MustCompile(line).MatchString(r.Stdout) {
			t.Errorf("info doesn't match %s:\n%s", line, r.Stdout)
		}
	}

	r = run(t, []string{"snapshot", "info", "snap_1", "--json"}, opts{routes: pages})
	eq(t, "by ID", strings.Join(paths(r.Calls), " "), "/v1/snapshots/snap_1")
	var body map[string]any
	_ = json.Unmarshal([]byte(r.Stdout), &body)
	eq(t, "json labels", body["labels"].(map[string]any)["git.base"], any("9540593c"))

	// Saved straight from a running sandbox, its state is the save's: one time.
	r = run(t, []string{"snapshot", "info", "snap_1"}, opts{routes: routes{
		"GET /v1/snapshots/snap_1": func(call) any {
			return withFields(savedSnapshot, map[string]any{"takenAt": savedSnapshot["createdAt"]})
		},
	}})
	if regexp.MustCompile(`(?m)^taken`).MatchString(r.Stdout) {
		t.Errorf("one time shown twice:\n%s", r.Stdout)
	}

	r = run(t, []string{"snapshot", "info", "nope"}, opts{routes: routes{
		"GET /v1/snapshots": func(call) any { return map[string]any{"items": []any{}} },
	}})
	eq(t, "missing exit", r.Code, 1)
	contains(t, "missing", r.Stderr, `there is no snapshot nope, or saved one called "nope"`)

	// A saved name may start as an ID does: not found as an ID, it is looked for by name.
	r = run(t, []string{"snapshot", "info", "snap_checks"}, opts{routes: routes{
		"GET /v1/snapshots": func(call) any {
			return map[string]any{"items": []any{withFields(savedSnapshot, map[string]any{"name": "snap_checks"})}}
		},
		"GET /v1/snapshots/snap_1": func(call) any { return withFields(savedSnapshot, map[string]any{"name": "snap_checks"}) },
	}})
	eq(t, "prefixed exit", r.Code, 0)
	eq(t, "prefixed paths", strings.Join(paths(r.Calls), " "), "/v1/snapshots/snap_checks /v1/snapshots /v1/snapshots/snap_1")
	if !regexp.MustCompile(`(?m)^name\s+snap_checks$`).MatchString(r.Stdout) {
		t.Errorf("prefixed:\n%s", r.Stdout)
	}

	// Any other failure of the ID lookup is that failure, not a missing name.
	r = run(t, []string{"snapshot", "info", "snap_1"}, opts{routes: routes{
		"GET /v1/snapshots/snap_1": func(call) any { return kantelError(403, "forbidden", "No") },
	}})
	eq(t, "failing exit", r.Code, 1)
	eq(t, "failing calls", len(r.Calls), 1)
}

func TestSnapshotFilesAndRm(t *testing.T) {
	r := run(t, []string{"snapshot", "files", "snap_1", "/home/user"}, opts{routes: routes{
		"GET /v1/snapshots/snap_1/files": func(call) any {
			return map[string]any{"path": "/home/user", "nextCursor": "n2", "items": []any{
				map[string]any{"kind": "directory", "name": "app", "path": "/home/user/app", "size": 4096},
				map[string]any{"kind": "file", "name": "notes.txt", "path": "/home/user/notes.txt", "size": 2048},
			}}
		},
	}})
	eq(t, "exit", r.Code, 0)
	eq(t, "path", query(r.Calls[0], "path"), "/home/user")
	eq(t, "out", r.Stdout, "KIND  SIZE     MODIFIED  NAME\ndir                      app/\nfile  2.0 KiB            notes.txt\n\n"+
		"More: kantel snapshot files snap_1 /home/user --cursor n2\n")

	// Kantel's own 503 is its answer: read once.
	r = run(t, []string{"snapshot", "files", "snap_1"}, opts{routes: routes{
		"GET /v1/snapshots/snap_1/files": func(call) any { return kantelError(503, "unavailable", "The compute API failed") },
	}})
	eq(t, "503 exit", r.Code, 1)
	contains(t, "503", r.Stderr, "kantel: unavailable: The compute API failed")
	eq(t, "503 calls", len(r.Calls), 1)

	r = run(t, []string{"snapshot", "rm", "snap_1"}, opts{routes: routes{"DELETE /v1/snapshots/snap_1": func(call) any { return nil }}})
	eq(t, "rm", r.Stdout, "Deleted snap_1.\n")
	r = run(t, []string{"snapshot", "delete", "snap_1", "--json"}, opts{routes: routes{"DELETE /v1/snapshots/snap_1": func(call) any { return nil }}})
	eq(t, "rm json", r.Stdout, "{\n  \"deleted\": \"snap_1\"\n}\n")
}

// query is one of a call's query parameters.
func query(c call, name string) string { return url.Values(c.Query).Get(name) }
