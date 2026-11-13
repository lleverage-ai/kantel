package kantel

import (
	"strings"
	"testing"
	"time"
)

func ownHost(fields map[string]any) map[string]any {
	h := map[string]any{
		"id": "host_own1", "name": "tom-box", "state": "online", "version": "0.4.0", "os": "linux", "arch": "x86_64",
		"tiers": []any{"microvm", "isolate"}, "kvm": true, "nestedVirtualisation": false,
		"capacity":  map[string]any{"vcpus": 8, "memoryMb": 16384, "diskGb": 200},
		"allocated": map[string]any{"sandboxes": 2, "vcpus": 4, "memoryMb": 4096, "diskGb": 40},
		"labels":    map[string]any{"site": "home"}, "accountId": "acc_org",
		"joinedAt": time.Now().UnixMilli(), "lastSeenAt": time.Now().UnixMilli(),
	}
	for k, v := range fields {
		h[k] = v
	}
	return h
}

func TestHostsAdd(t *testing.T) {
	r := routes{"POST /v1/hosts/join-tokens": func(c call) any {
		return map[string]any{"id": "enr_1", "accountId": c.Body["account"], "token": "kth_secret",
			"command":   "curl -fsSL https://x/install.sh | sudo sh -s -- --url https://kantel.test --token kth_secret",
			"expiresAt": time.Now().UnixMilli() + 3_600_000}
	}}
	enrolled := run(t, []string{"hosts", "add", "tom-box", "--label", "site=home", "--expires", "30", "--account", "acc_org"}, opts{routes: r})
	eq(t, "exit", enrolled.Code, 0)
	jsonEq(t, "body", enrolled.Calls[0].Body, `{"account":"acc_org","name":"tom-box","labels":{"site":"home"},"expiresInMinutes":30}`)
	contains(t, "command", enrolled.Stdout, "--token kth_secret")
	contains(t, "account", enrolled.Stdout, "It joins account acc_org")
	// Too short a token's life is refused before calling Kantel.
	short := run(t, []string{"hosts", "add", "--expires", "1"}, opts{routes: r})
	eq(t, "short exit", short.Code, 2)
	eq(t, "short calls", len(short.Calls), 0)
}

func TestHostsListInfoDrainRemove(t *testing.T) {
	r := routes{
		"GET /v1/hosts":           func(call) any { return map[string]any{"items": []any{ownHost(nil)}} },
		"GET /v1/hosts/host_own1": func(call) any { return ownHost(nil) },
		"PATCH /v1/hosts/host_own1": func(c call) any {
			state := "online"
			if c.Body["draining"] == true {
				state = "draining"
			}
			return ownHost(map[string]any{"state": state})
		},
		"DELETE /v1/hosts/host_own1": func(call) any { return ownHost(map[string]any{"state": "revoked"}) },
	}
	listed := run(t, []string{"hosts", "ls"}, opts{routes: r})
	matches(t, "list", listed.Stdout, `^ID\s+NAME\s+STATE\s+TIERS\s+SANDBOXES`)
	matches(t, "row", listed.Stdout, `host_own1\s+tom-box\s+online\s+microvm,isolate\s+2\s+just now`)
	shown := run(t, []string{"hosts", "info", "host_own1"}, opts{routes: r})
	contains(t, "account", shown.Stdout, "acc_org")
	contains(t, "labels", shown.Stdout, "site=home")
	matches(t, "machine", shown.Stdout, `machine\s+linux/x86_64`)
	matches(t, "capacity", shown.Stdout, `capacity\s+8 vCPUs, 16384 MB memory, 200 GB disk`)
	drained := run(t, []string{"hosts", "drain", "host_own1"}, opts{routes: r})
	jsonEq(t, "drain", drained.Calls[0].Body, `{"draining":true}`)
	eq(t, "drain out", drained.Stdout, "host_own1 (tom-box) is draining.\n")
	undrained := run(t, []string{"hosts", "drain", "host_own1", "--off"}, opts{routes: r})
	jsonEq(t, "undrain", undrained.Calls[0].Body, `{"draining":false}`)
	// Not without --yes.
	unsure := run(t, []string{"hosts", "rm", "host_own1"}, opts{routes: r})
	eq(t, "unsure exit", unsure.Code, 2)
	eq(t, "unsure calls", len(unsure.Calls), 0)
	contains(t, "unsure", unsure.Stderr, "kantel hosts rm host_own1 --yes")
	removed := run(t, []string{"hosts", "rm", "host_own1", "--yes"}, opts{routes: r})
	eq(t, "removed calls", strings.Join(lines(removed.Calls), ", "), "DELETE /v1/hosts/host_own1")
	eq(t, "removed", removed.Stdout, "Removed host_own1 (tom-box); it is revoked.\n")
	empty := run(t, []string{"hosts", "list"}, opts{routes: routes{"GET /v1/hosts": func(call) any { return map[string]any{"items": []any{}} }}})
	contains(t, "empty", empty.Stdout, "kantel hosts add")
}

func TestPoolsAndHostsMove(t *testing.T) {
	pool := func(id, name string, def bool) map[string]any {
		return map[string]any{"id": id, "name": name, "default": def, "hosts": 1, "accountId": "acc_org", "createdAt": 1}
	}
	r := routes{
		"GET /v1/pools": func(call) any {
			return map[string]any{"items": []any{pool("pool_acc_org", "default", true), pool("pool_ci", "ci", false)}}
		},
		"POST /v1/pools":           func(c call) any { return pool("pool_ci", c.Body["name"].(string), false) },
		"PATCH /v1/pools/pool_ci":  func(c call) any { return pool("pool_ci", "builds", c.Body["default"] == true) },
		"DELETE /v1/pools/pool_ci": func(call) any { return nil },
		"PATCH /v1/hosts/host_own1": func(c call) any {
			return ownHost(map[string]any{"state": "draining", "poolId": "pool_ci"})
		},
		"GET /v1/hosts/host_own1": func(call) any {
			return ownHost(map[string]any{"poolId": "pool_ci"})
		},
		"POST /v1/hosts/join-tokens": func(c call) any {
			return map[string]any{"id": "enr_1", "accountId": "acc_org", "token": "kth_secret", "command": "install",
				"expiresAt": time.Now().UnixMilli() + 3_600_000}
		},
	}
	listed := run(t, []string{"pools", "list", "--account", "acc_org"}, opts{routes: r})
	matches(t, "list", listed.Stdout, `pool_acc_org\s+default\s+yes\s+1`)
	made := run(t, []string{"pools", "add", "ci", "--account", "acc_org"}, opts{routes: r})
	jsonEq(t, "add", made.Calls[0].Body, `{"account":"acc_org","name":"ci"}`)
	eq(t, "add out", made.Stdout, "Made pool ci (pool_ci).\n")
	// With --account, a name is looked up in that account.
	renamed := run(t, []string{"pools", "rename", "ci", "builds", "--account", "acc_org"}, opts{routes: r})
	eq(t, "rename calls", strings.Join(lines(renamed.Calls), ", "), "GET /v1/pools, PATCH /v1/pools/pool_ci")
	eq(t, "rename out", renamed.Stdout, "pool_ci is now builds.\n")
	defaulted := run(t, []string{"pools", "default", "pool_ci"}, opts{routes: r})
	jsonEq(t, "default", defaulted.Calls[0].Body, `{"default":true}`)
	removed := run(t, []string{"pools", "rm", "pool_ci"}, opts{routes: r})
	eq(t, "rm calls", strings.Join(lines(removed.Calls), ", "), "DELETE /v1/pools/pool_ci")
	missing := run(t, []string{"pools", "rm", "nowhere", "--account", "acc_org"}, opts{routes: r})
	eq(t, "missing exit", missing.Code, 1)
	contains(t, "missing", missing.Stderr, "no pool named nowhere")

	moved := run(t, []string{"hosts", "move", "host_own1", "pool_ci"}, opts{routes: r})
	jsonEq(t, "move", moved.Calls[0].Body, `{"pool":"pool_ci"}`)
	eq(t, "move out", moved.Stdout, "host_own1 (tom-box) is in pool_ci; it is draining.\n")
	shown := run(t, []string{"hosts", "info", "host_own1"}, opts{routes: r})
	matches(t, "pool", shown.Stdout, `pool\s+pool_ci`)
	added := run(t, []string{"hosts", "add", "--pool", "ci", "--account", "acc_org"}, opts{routes: r})
	jsonEq(t, "add host", added.Calls[1].Body, `{"account":"acc_org","pool":"pool_ci"}`)
}

func TestHostMemory(t *testing.T) {
	memory := map[string]any{"totalMiB": 65536, "reserveMiB": 4096, "capacityMiB": 61440, "reservedMiB": 30720,
		"committedMiB": 15360, "guestUsedMiB": 10240, "residentMiB": 12288, "availableMiB": 40960, "swapUsedMiB": 0,
		"pressureSome": 1.25, "pressureFull": 0, "maxRatio": 1.5, "mode": "used", "state": "ok"}
	r := routes{"GET /v1/hosts/host_own1": func(call) any { return ownHost(map[string]any{"memory": memory}) }}
	shown := run(t, []string{"hosts", "info", "host_own1"}, opts{routes: r})
	matches(t, "memory", shown.Stdout, `memory\s+60\.0 GB for sandboxes of 64\.0 GB, 4\.0 GB kept for the host`)
	matches(t, "admits", shown.Stdout, `admits\s+by use \(over-commit, experimental\), at most 1\.5x given`)
	matches(t, "reserved", shown.Stdout, `reserved\s+30\.0 GB \(50%\)`)
	matches(t, "available", shown.Stdout, `available\s+40\.0 GB, swap 0\.0 GB, pressure 1\.3% some, 0\.0% full`)
	matches(t, "state", shown.Stdout, `memory state\s+ok`)
}

func TestHostsRefusedWhileOff(t *testing.T) {
	r := run(t, []string{"hosts", "list"}, opts{routes: routes{"GET /v1/hosts": func(call) any {
		return kantelError(501, "not_supported", "Account hosts are off on this deployment (KANTEL_ACCOUNT_HOSTS)")
	}}})
	eq(t, "exit", r.Code, 1)
	contains(t, "err", r.Stderr, "not_supported: Account hosts are off")
}

func TestWebhooksEventsAndTelemetry(t *testing.T) {
	r := routes{
		"GET /v1/webhooks": func(call) any {
			return map[string]any{"items": []any{map[string]any{"id": "whk_1", "name": "ci", "url": "https://ci.example/hook",
				"enabled": true, "events": []any{}, "accountId": "acc_1", "createdAt": 1,
				"lastDelivery": map[string]any{"at": time.Now().UnixMilli(), "ok": false}}}}
		},
		"POST /v1/webhooks": func(c call) any {
			return map[string]any{"secret": "whsec_x", "webhook": map[string]any{"id": "whk_2", "name": c.Body["name"], "url": c.Body["url"],
				"enabled": true, "events": c.Body["events"], "accountId": "acc_1", "createdAt": 1}}
		},
		"POST /v1/webhooks/whk_1/test": func(call) any {
			return map[string]any{"id": "dlv_1", "webhookId": "whk_1", "eventId": "evt_1", "eventType": "sandbox.created",
				"state": "failed", "attempts": 1, "createdAt": 1, "lastStatus": 500}
		},
		"GET /v1/events": func(call) any {
			return map[string]any{"nextCursor": "c2", "items": []any{
				map[string]any{"id": "evt_1", "accountId": "acc_1", "createdAt": time.Date(2026, 11, 3, 14, 5, 0, 0, time.UTC).UnixMilli(),
					"type": "sandbox.stopped", "sandboxId": "sbx_1",
					"data": map[string]any{"name": "brisk-otter", "previousState": "running", "state": "stopped", "reason": "idle"}},
			}}
		},
		"GET /v1/telemetry": func(call) any { return kantelError(404, "not_found", "No telemetry export") },
		"PUT /v1/telemetry": func(call) any {
			return map[string]any{"telemetry": map[string]any{"accountId": "acc_1", "endpoint": "https://otel", "headerNames": []any{},
				"signals": []any{"metrics"}, "updatedAt": 1}, "test": map[string]any{"ok": false, "status": 401, "error": "unauthorised"}}
		},
		"DELETE /v1/telemetry": func(call) any { return nil },
	}
	hooks := run(t, []string{"webhook", "list"}, opts{routes: r})
	matches(t, "hooks", hooks.Stdout, `whk_1\s+ci\s+https://ci.example/hook\s+enabled\s+failed just now`)
	made := run(t, []string{"webhook", "create", "https://Hooks.Example.com:443/x", "--event", "sandbox.error"}, opts{routes: r})
	eq(t, "made exit", made.Code, 0)
	jsonEq(t, "made body", last(made).Body, `{"name":"hooks.example.com","url":"https://Hooks.Example.com:443/x","events":["sandbox.error"]}`)
	contains(t, "secret", made.Stdout, "  whsec_x\n")
	all := run(t, []string{"webhook", "create", "https://hooks.example.com/x"}, opts{routes: r})
	eq(t, "all events", len(last(all).Body["events"].([]any)), len(EventTypes))
	badEvent := run(t, []string{"webhook", "create", "https://x", "--event", "nope"}, opts{routes: r})
	eq(t, "bad event", badEvent.Code, 2)
	tested := run(t, []string{"webhook", "test", "whk_1"}, opts{routes: r})
	eq(t, "test exit", tested.Code, 1)
	eq(t, "test out", tested.Stdout, "failed (500)\n")

	events := run(t, []string{"events", "--type", "sandbox.stopped"}, opts{routes: r})
	eq(t, "events exit", events.Code, 0)
	eq(t, "type", strings.Join(last(events).Query["type"], ""), "sandbox.stopped")
	matches(t, "event", events.Stdout, `2026-11-03 14:05 UTC\s+sandbox\.stopped\s+sbx_1\s+brisk-otter, running to stopped, idle`)
	contains(t, "more", events.Stdout, "\n\nMore: kantel events --cursor c2")

	none := run(t, []string{"telemetry", "get"}, opts{routes: r})
	eq(t, "none exit", none.Code, 0)
	eq(t, "none", none.Stdout, "No OpenTelemetry export is set.\n")
	noneJSON := run(t, []string{"telemetry", "get", "--json"}, opts{routes: r})
	eq(t, "none json", noneJSON.Stdout, "null\n")
	set := run(t, []string{"telemetry", "set", "https://otel", "--header", "Authorization=Bearer x", "--signal", "metrics"}, opts{routes: r})
	jsonEq(t, "set body", last(set).Body, `{"endpoint":"https://otel","headers":{"Authorization":"Bearer x"},"signals":["metrics"]}`)
	eq(t, "set out", set.Stdout, "Saved, but the collector refused a test export (401): unauthorised.\n")
	removed := run(t, []string{"telemetry", "rm"}, opts{routes: r})
	eq(t, "rm out", removed.Stdout, "Removed the OpenTelemetry export.\n")
}

func TestToFixed(t *testing.T) {
	for x, want := range map[float64]string{1.25: "1.3", 0: "0.0", 0.05: "0.1", 2.45: "2.5", 1.005: "1.0", 60: "60.0", 0.04: "0.0", 12.96: "13.0"} {
		eq(t, "toFixed", toFixed(x, 1), want)
	}
	eq(t, "negative", toFixed(-1.25, 1), "-1.3")
}
