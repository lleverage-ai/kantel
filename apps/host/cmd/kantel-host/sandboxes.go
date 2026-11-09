package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/agent"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// sandboxesCmd lists the sandboxes the running daemon holds, or shows one, from its control socket. It only reads:
// sandboxes are stopped and deleted through Kantel, which is their record.
func sandboxesCmd(args []string) error {
	show := len(args) > 0 && args[0] == "show"
	if show {
		args = args[1:]
	}
	name := "sandboxes"
	if show {
		name = "sandboxes show"
	}
	fs := newFlags(name)
	configPath := fs.String("config", defaultConfigPath, "The settings `file`")
	socket := fs.String("socket", "", "The daemon's control socket, a `path` (default: the config's, or "+agent.DefaultControlSocket+")")
	asJSON := fs.Bool("json", false, "Print JSON")
	rest, err := fs.parseInterspersed(args)
	if err != nil {
		return err
	}
	if show && len(rest) != 1 {
		if len(rest) == 0 {
			return usageErrorf(name, "sandboxes show needs <id>")
		}
		return usageErrorf(name, "sandboxes show takes one <id>, and got %d", len(rest))
	}
	if !show && len(rest) > 0 {
		return usageErrorf(name, "unexpected %q (to see one sandbox: kantel-host sandboxes show <id>)", rest[0])
	}
	c := controlClient{path: controlSocketPath(*configPath, *socket)}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if show {
		info, err := c.sandbox(ctx, rest[0])
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(stdout, info)
		}
		printSandbox(stdout, info, time.Now())
		return nil
	}
	list, err := c.list(ctx)
	if err != nil {
		return err
	}
	if *asJSON {
		return writeJSON(stdout, list)
	}
	printSandboxes(stdout, list, time.Now())
	return nil
}

// controlSocketPath is --socket, else the config's controlSocket, else the default. A config this user can't read
// (not root) gives the default.
func controlSocketPath(configPath, flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	cfg, _ := agent.LoadConfig(configPath)
	cfg.Defaults()
	if cfg.ControlSocket == "off" {
		return agent.DefaultControlSocket
	}
	return cfg.ControlSocket
}

// controlClient talks to the daemon's control socket (agent.ControlHandler).
type controlClient struct {
	path string
}

func (c controlClient) list(ctx context.Context) ([]proto.SandboxInfo, error) {
	var out []proto.SandboxInfo
	return out, c.get(ctx, "/sandboxes", &out)
}

func (c controlClient) sandbox(ctx context.Context, id string) (proto.SandboxInfo, error) {
	var out proto.SandboxInfo
	return out, c.get(ctx, "/sandboxes/"+url.PathEscape(id), &out)
}

func (c controlClient) get(ctx context.Context, path string, out any) error {
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", c.path)
		},
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://kantel-host"+path, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return c.dialError(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error *proto.Error `json:"error"`
		}
		if json.Unmarshal(body, &e) == nil && e.Error != nil {
			return errors.New(e.Error.Message)
		}
		return fmt.Errorf("the service answered %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	return json.Unmarshal(body, out)
}

// dialError says what a failure to reach the socket most likely means.
func (c controlClient) dialError(err error) error {
	switch {
	case errors.Is(err, os.ErrNotExist):
		return fmt.Errorf("no control socket at %s: is the service running? (systemctl status kantel-host)", c.path)
	case errors.Is(err, os.ErrPermission):
		return fmt.Errorf("can't open %s: it is root's only, so run this as root (sudo kantel-host ...)", c.path)
	case errors.Is(err, syscall.ECONNREFUSED):
		return fmt.Errorf("nothing answers on %s: the service isn't running (systemctl status kantel-host)", c.path)
	case errors.Is(err, io.EOF), errors.Is(err, syscall.ECONNRESET):
		// The daemon closes connections from anyone but root and its own user.
		return fmt.Errorf("the service closed the connection on %s: run this as root (sudo kantel-host ...)", c.path)
	}
	return fmt.Errorf("couldn't reach the service on %s: %w", c.path, err)
}

func writeJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// printSandboxes is the sandboxes table, oldest first.
func printSandboxes(w io.Writer, list []proto.SandboxInfo, now time.Time) {
	if len(list) == 0 {
		fmt.Fprintln(w, "No sandboxes on this host.")
		return
	}
	list = append([]proto.SandboxInfo(nil), list...)
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].CreatedAt != list[j].CreatedAt {
			return list[i].CreatedAt < list[j].CreatedAt
		}
		return list[i].ID < list[j].ID
	})
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "id\ttier\tsize\tstate\towner\tbase\taddress\tcreated")
	for _, s := range list {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", s.ID, dash(s.Tier), dash(s.Size), dash(s.State), dash(s.Owner),
			dash(s.Base), dash(s.Address), ago(s.CreatedAt, now))
	}
	_ = tw.Flush()
}

// printSandbox is one sandbox, a field to a line, as status prints.
func printSandbox(w io.Writer, s proto.SandboxInfo, now time.Time) {
	line := func(k, v string) {
		if v != "" {
			fmt.Fprintf(w, "%-13s %s\n", k, v)
		}
	}
	line("id", s.ID)
	line("tier", s.Tier)
	line("size", s.Size)
	state := s.State
	if s.Memory {
		state += " (memory kept)"
	}
	line("state", state)
	line("error", s.Error)
	line("owner", s.Owner)
	line("address", s.Address)
	base := s.Base
	if base != "" && s.BaseAt > 0 {
		base += ", since " + stamp(s.BaseAt, now)
	}
	line("base", base)
	if s.CreatedAt > 0 {
		line("created", stamp(s.CreatedAt, now))
	}
	if g := s.Guest; g != nil {
		guest := strings.TrimSpace(g.OS.Name + " " + g.OS.Version)
		if g.Arch != "" {
			guest += ", " + g.Arch
		}
		if g.Agent.Version != "" {
			guest += ", agent " + g.Agent.Version
			if g.Agent.Injected {
				guest += " (injected)"
			}
		}
		line("guest", strings.TrimPrefix(guest, ", "))
	}
	for i, m := range s.Mounts {
		k := ""
		if i == 0 {
			k = "mounts"
		}
		v := m.Path + " " + m.State
		if m.Kind != "" {
			v = m.Path + " (" + m.Kind + ") " + m.State
		}
		if m.Error != "" {
			v += ": " + m.Error
		}
		fmt.Fprintf(w, "%-13s %s\n", k, v)
	}
}

// stateCounts is status's sandboxes line: how many, and how many in each state.
func stateCounts(list []proto.SandboxInfo) string {
	return countsText(countStates(list))
}

// countStates is how many sandboxes are in each state ("-" for none given).
func countStates(list []proto.SandboxInfo) map[string]int {
	counts := map[string]int{}
	for _, s := range list {
		counts[dash(s.State)]++
	}
	return counts
}

// countsText is counts as status's sandboxes line: "3 (2 running, 1 stopped)", or "none".
func countsText(counts map[string]int) string {
	total := 0
	states := make([]string, 0, len(counts))
	for st, n := range counts {
		total += n
		states = append(states, st)
	}
	if total == 0 {
		return "none"
	}
	sort.Strings(states)
	parts := make([]string, len(states))
	for i, st := range states {
		parts[i] = fmt.Sprintf("%d %s", counts[st], st)
	}
	return fmt.Sprintf("%d (%s)", total, strings.Join(parts, ", "))
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// ago is a unix-milliseconds time as how long before now it was: 45s ago, 12m ago, 3h ago, 5d ago.
func ago(ms int64, now time.Time) string {
	if ms <= 0 {
		return "-"
	}
	d := now.Sub(time.UnixMilli(ms))
	switch {
	case d < 0:
		return "just now"
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	}
	return fmt.Sprintf("%dd ago", int(d.Hours()/24))
}

// stamp is a unix-milliseconds time in UTC, and how long ago it was.
func stamp(ms int64, now time.Time) string {
	return time.UnixMilli(ms).UTC().Format(time.RFC3339) + " (" + ago(ms, now) + ")"
}
