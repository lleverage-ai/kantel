package kantel

import (
	"fmt"
	"math"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// How sandboxes read, for a person.

// KindOf is a sandbox's type and size: `microvm small`, or `isolate`.
func KindOf(s api.Sandbox) string {
	if s.Type == api.SandboxTypeMicrovm && s.Size != nil {
		return "microvm " + string(*s.Size)
	}
	return string(s.Type)
}

// diskOf is a microVM's disk, for a line about it: ", 60 GB disk"; nothing until it is placed.
func diskOf(s api.Sandbox) string {
	if s.Type == api.SandboxTypeMicrovm && s.Resources != nil && s.Resources.DiskGb > 0 {
		return fmt.Sprintf(", %d GB disk", s.Resources.DiskGb)
	}
	return ""
}

// StateOf is a sandbox's state with why: `error (insufficient_capacity): out of memory`.
func StateOf(s api.Sandbox) string {
	state := string(s.State)
	if s.PlacementReason != nil {
		state += " (" + string(*s.PlacementReason) + ")"
	}
	if s.Reason != nil {
		state += ": " + *s.Reason
	}
	return state
}

// hostOf is the host a sandbox is on, by name, as far as the caller is shown it.
func hostOf(s api.Sandbox) string {
	if s.HostName != nil {
		return *s.HostName
	}
	return Deref(s.HostID)
}

// SandboxTable is sandboxes in a table; a host column only when the caller is shown any.
func SandboxTable(c *cli.Context, sandboxes []api.Sandbox) string {
	hosts := false
	for _, s := range sandboxes {
		if hostOf(s) != "" {
			hosts = true
		}
	}
	header := []string{"ID", "NAME", "TYPE", "STATE"}
	if hosts {
		header = append(header, "HOST")
	}
	header = append(header, "CREATED", "STOPS")
	var rows [][]string
	for _, s := range sandboxes {
		row := []string{s.ID, s.Name, KindOf(s), c.Style.State(string(s.State))}
		if hosts {
			row = append(row, hostOf(s))
		}
		stops := ""
		if s.StopsAt != nil {
			stops = cli.Until(*s.StopsAt, now(c))
		}
		row = append(row, cli.Ago(s.CreatedAt, now(c)), stops)
		rows = append(rows, row)
	}
	return cli.Table(c.Style, header, rows)
}

// idleStopText is "after 30 min unused (stops in 28 min unless used)", or "" with no idle stop.
func idleStopText(c *cli.Context, s api.Sandbox) string {
	minutes, ok := s.IdleStopMinutes.Get()
	if !ok {
		return ""
	}
	idle := fmt.Sprintf("after %d min unused", minutes)
	if s.IdleStopsAt != nil {
		idle += fmt.Sprintf(" (stops %s unless used)", cli.Until(*s.IdleStopsAt, now(c)))
	}
	return idle
}

func percent(share float64) string { return fmt.Sprintf("%d%%", int(math.Round(share*100))) }

// GuestMemoryText is a guest's memory figures: "pressure 85% (full 41%), 2 processes killed for memory since boot".
func GuestMemoryText(m *api.GuestMemory) string {
	if m == nil {
		return ""
	}
	var parts []string
	if m.PressureSome != nil {
		full := ""
		if m.PressureFull != nil {
			full = " (full " + percent(*m.PressureFull) + ")"
		}
		parts = append(parts, "pressure "+percent(*m.PressureSome)+full)
	}
	if m.OOMKills != nil {
		kills := fmt.Sprintf("%d processes", *m.OOMKills)
		switch *m.OOMKills {
		case 0:
			kills = "none"
		case 1:
			kills = "1 process"
		}
		parts = append(parts, kills+" killed for memory since boot")
	}
	return strings.Join(parts, ", ")
}

var diskMade = map[api.SandboxStartupDisk]string{"reflink": "disk cloned", "copy": "disk copied", "move": "disk moved", "new": "new disk"}

// startupText is how its latest start took its time: `21.4 s on its host (22.0 s in all): disk copied 18.2 s, …`.
func startupText(s api.Sandbox) string {
	st := s.Startup
	if st == nil {
		return ""
	}
	sec := func(ms float64) string { return fmt.Sprintf("%.1f s", ms/1000) }
	var phases []string
	if st.SnapshotMs != nil {
		phases = append(phases, "snapshot "+sec(*st.SnapshotMs))
	}
	disk := "disk"
	if st.Disk != nil {
		disk = diskMade[*st.Disk]
	}
	phases = append(phases, disk+" "+sec(st.DiskMs), "boot "+sec(st.BootMs), "guest agent "+sec(st.AgentMs))
	return fmt.Sprintf("%s on its host (%s in all): %s", sec(st.HostMs), sec(st.TotalMs), strings.Join(phases, ", "))
}

// environmentIDsOf is a sandbox's environments, in order; from an older Kantel, the one it was made from.
func environmentIDsOf(s api.Sandbox) []string {
	if len(s.EnvironmentIds) > 0 {
		return s.EnvironmentIds
	}
	if s.EnvironmentID != nil {
		return []string{*s.EnvironmentID}
	}
	return nil
}

// environmentsText is environments in order, each by name with its ID: `backend (env_1), npm (env_2)`, or by its ID
// alone where its name isn't known.
func environmentsText(ids []string, names map[string]string) string {
	var out []string
	for _, id := range ids {
		if name := names[id]; name != "" {
			out = append(out, name+" ("+id+")")
		} else {
			out = append(out, id)
		}
	}
	return strings.Join(out, ", ")
}

// DescribeSandbox is one sandbox, field by field, for kantel info; names are its environments' names by ID, as far as
// they are known.
func DescribeSandbox(c *cli.Context, s api.Sandbox, names map[string]string) string {
	machine := []string{string(s.Type)}
	if s.Size != nil {
		machine = append(machine, string(*s.Size))
	}
	if r := s.Resources; r != nil {
		machine = append(machine, fmt.Sprintf("%d vCPU, %d MB, %d GB", r.VCPUs, r.MemoryMb, r.DiskGb))
	}
	autoStop := "never"
	if m, ok := s.AutoStopMinutes.Get(); ok {
		autoStop = fmt.Sprintf("after %d min", m)
	}
	if s.StopsAt != nil {
		autoStop += " (stops " + cli.Until(*s.StopsAt, now(c)) + ")"
	}
	var labels []string
	for _, k := range sortedKeys(s.Labels) {
		labels = append(labels, k+"="+s.Labels[k])
	}
	host := Deref(s.HostID)
	if s.HostName != nil && s.HostID != nil {
		host = *s.HostName + " (" + *s.HostID + ")"
	}
	health := ""
	if s.Health != nil && *s.Health == api.SandboxHealthDegraded {
		health = c.Style.State("degraded")
	}
	return cli.Fields(c.Style, []cli.Field{
		{"id", s.ID},
		{"name", s.Name},
		{"type", strings.Join(machine, ", ")},
		{"image", Deref(s.Image)},
		{"state", c.Style.State(StateOf(s))},
		{"health", health},
		{"host", host},
		{"visibility", string(s.Visibility)},
		{"labels", strings.Join(labels, ", ")},
		{"environments", environmentsText(environmentIDsOf(s), names)},
		{"auto-stop", autoStop},
		{"idle stop", idleStopText(c, s)},
		{"snapshot", Deref(s.LatestSnapshotID)},
		{"created", cli.Timestamp(s.CreatedAt) + " (" + cli.Ago(s.CreatedAt, now(c)) + ")"},
		{"started in", startupText(s)},
		{"running", cli.Duration(s.Usage.RunningSeconds)},
		{"memory", GuestMemoryText(s.Usage.Memory)},
		{"cost", fmt.Sprintf("%s (%s an hour)", cli.Money(s.Cost.Total, s.Cost.Currency), cli.Money(s.Cost.RatePerHour, s.Cost.Currency))},
	})
}

// gbOf is GB from MB: `16`, or `0.5`.
func gbOf(mb int64) string {
	v := math.Round(float64(mb)/1024*100) / 100
	return strings.TrimSuffix(strings.TrimRight(fmt.Sprintf("%.2f", v), "0"), ".")
}

// describeShapes is kantel sizes: the named sizes the hosts offer, and the other shapes a microVM may be.
func describeShapes(c *cli.Context, shapes api.SandboxShapes) string {
	m := shapes.Microvm
	if m == nil {
		return "No host this account may use runs microVMs: a new sandbox is an isolate."
	}
	rates := shapes.Rates
	header := []string{"SIZE", "VCPUS", "MEMORY", "DISK"}
	if rates != nil {
		header = append(header, "AN HOUR")
	}
	var rows [][]string
	for _, p := range m.Presets {
		row := []string{string(p.Name), fmt.Sprint(p.VCPUs), gbOf(p.MemoryMb) + " GB", fmt.Sprintf("%d GB", p.DiskGb)}
		if rates != nil {
			row = append(row, cli.Money(float64(p.VCPUs)*rates.MicrovmPerVCPUHour+float64(p.MemoryMb)/1024*rates.MicrovmPerGbHour, rates.Currency))
		}
		rows = append(rows, row)
	}
	lines := []string{"The hosts name no sizes.", ""}
	if len(rows) > 0 {
		lines[0] = cli.Table(c.Style, header, rows)
	}
	if m.Custom {
		lines = append(lines,
			fmt.Sprintf("Other shapes, with --vcpus and --memory: %d to %d vCPUs and %s to %s GB of memory, %s to %s GB a vCPU.",
				int64(m.VCPUs.Min), int64(m.VCPUs.Max), gbOf(int64(m.MemoryMb.Min)), gbOf(int64(m.MemoryMb.Max)),
				gbOf(int64(m.MemoryMbPerVCPU.Min)), gbOf(int64(m.MemoryMbPerVCPU.Max))),
			"  kantel new --type microvm --vcpus 8 --memory 16")
	} else {
		lines = append(lines, "No other shapes: these hosts make only their named sizes.")
	}
	if m.DiskGb != nil {
		lines = append(lines, fmt.Sprintf("A disk of %d to %d GB with --disk, whatever the shape.", int64(m.DiskGb.Min), int64(m.DiskGb.Max)))
	}
	return strings.Join(lines, "\n")
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sortStrings(keys)
	return keys
}
