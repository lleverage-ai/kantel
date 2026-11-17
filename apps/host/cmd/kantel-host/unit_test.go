package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The unit keeps running when the kernel kills one of its VMs for memory, and leaves VMs running across a restart.
func TestUnitContinuesPastAnOOMKill(t *testing.T) {
	for _, line := range []string{"OOMPolicy=continue", "KillMode=process", "Restart=always"} {
		if !strings.Contains(unit, "\n"+line+"\n") {
			t.Errorf("the unit has no %s", line)
		}
	}
	// The previous unit is the one the earlier releases installed, the new one with its one line more.
	if strings.Replace(unit, "OOMPolicy=continue\n", "", 1) != unitBeforeOOMPolicy {
		t.Error("the previous unit isn't this one without OOMPolicy=continue")
	}
}

// A run brings a unit an earlier release installed up to date and has systemd read it again; a unit an operator
// changed, a current one or none is left as it is, and nothing is reloaded.
func TestUpgradeUnit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "kantel-host.service")
	reloads := 0
	reload := func() error { reloads++; return nil }

	if err := os.WriteFile(path, []byte(unitBeforeOOMPolicy), 0o644); err != nil {
		t.Fatal(err)
	}
	if upgraded, err := upgradeUnit(path, reload); err != nil || !upgraded {
		t.Fatalf("an earlier release's unit: upgraded %v, %v", upgraded, err)
	}
	if raw, _ := os.ReadFile(path); string(raw) != unit || reloads != 1 {
		t.Fatalf("after the upgrade: %d reloads, unit %q", reloads, raw)
	}
	// Up to date already: nothing to do.
	if upgraded, err := upgradeUnit(path, reload); err != nil || upgraded || reloads != 1 {
		t.Fatalf("a current unit: upgraded %v, %v, %d reloads", upgraded, err, reloads)
	}
	// An operator's own change is theirs.
	edited := strings.Replace(unitBeforeOOMPolicy, "RestartSec=2", "RestartSec=10", 1)
	if err := os.WriteFile(path, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	if upgraded, err := upgradeUnit(path, reload); err != nil || upgraded || reloads != 1 {
		t.Fatalf("an edited unit: upgraded %v, %v", upgraded, err)
	}
	if raw, _ := os.ReadFile(path); string(raw) != edited {
		t.Fatal("an edited unit was rewritten")
	}
	// No unit (no systemd install): nothing.
	if upgraded, err := upgradeUnit(filepath.Join(dir, "none.service"), reload); err != nil || upgraded {
		t.Fatalf("no unit: upgraded %v, %v", upgraded, err)
	}
	// A reload that fails is said, the unit written.
	if err := os.WriteFile(path, []byte(unitBeforeOOMPolicy), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := upgradeUnit(path, func() error { return errors.New("no systemd") }); err == nil {
		t.Fatal("a failed reload wasn't said")
	}
}
