package kantel

import (
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// toFixed is x to digits places as JavaScript's toFixed has it: of the two nearest, the larger on a tie, from x's
// exact value (where Go's %.1f rounds a tie to even).
func toFixed(x float64, digits int) string {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	sign := ""
	if x < 0 {
		sign, x = "-", -x
	}
	scaled := new(big.Float).SetPrec(256).SetFloat64(x)
	scaled.Mul(scaled, new(big.Float).SetPrec(256).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)))
	scaled.Add(scaled, big.NewFloat(0.5))
	n, _ := scaled.Int(nil)
	text := n.String()
	if digits == 0 {
		return sign + text
	}
	if len(text) <= digits {
		text = strings.Repeat("0", digits-len(text)+1) + text
	}
	out := text[:len(text)-digits] + "." + text[len(text)-digits:]
	if strings.Trim(out, "0.") == "" {
		sign = ""
	}
	return sign + out
}

// hostMemoryFields is a host's memory for kantel hosts info: what sandboxes were given and count for against what it
// has for them, what they use, and the machine's own figures.
func hostMemoryFields(m *api.HostMemory) []cli.Field {
	if m == nil {
		return nil
	}
	gb := func(mib int64) string { return toFixed(float64(mib)/1024, 1) + " GB" }
	share := func(mib int64) string {
		if m.CapacityMiB == 0 {
			return ""
		}
		return fmt.Sprintf(" (%d%%)", int64(math.Round(float64(mib)/float64(m.CapacityMiB)*100)))
	}
	ratio := strconv.FormatFloat(m.MaxRatio, 'f', -1, 64)
	mode := "by reservation, at most " + ratio + "x"
	if m.Mode == api.HostMemoryModeUsed {
		mode = "by use (over-commit, experimental), at most " + ratio + "x given"
	}
	return []cli.Field{
		{"memory", fmt.Sprintf("%s for sandboxes of %s, %s kept for the host", gb(m.CapacityMiB), gb(m.TotalMiB), gb(m.ReserveMiB))},
		{"admits", mode},
		{"reserved", gb(m.ReservedMiB) + share(m.ReservedMiB)},
		{"committed", gb(m.CommittedMiB) + share(m.CommittedMiB)},
		{"guest used", gb(m.GuestUsedMiB)},
		{"resident", gb(m.ResidentMiB)},
		{"available", fmt.Sprintf("%s, swap %s, pressure %s%% some, %s%% full", gb(m.AvailableMiB), gb(m.SwapUsedMiB),
			toFixed(m.PressureSome, 1), toFixed(m.PressureFull, 1))},
		{"memory state", string(m.State)},
	}
}

// describeHost is one of an account's own hosts, for kantel hosts info.
func describeHost(c *cli.Context, h api.Host) string {
	var labels []string
	for _, k := range sortedKeys(h.Labels) {
		labels = append(labels, k+"="+h.Labels[k])
	}
	var machine []string
	if h.OS != nil && *h.OS != "" {
		machine = append(machine, *h.OS)
	}
	if h.Arch != nil && *h.Arch != "" {
		machine = append(machine, string(*h.Arch))
	}
	tiers := make([]string, len(h.Tiers))
	for i, t := range h.Tiers {
		tiers[i] = string(t)
	}
	kvm := "no"
	if h.KVM {
		kvm = "yes"
	}
	lastSeen := ""
	if h.LastSeenAt != nil {
		lastSeen = cli.Ago(*h.LastSeenAt, now(c))
	}
	rows := []cli.Field{
		{"id", h.ID},
		{"name", h.Name},
		{"state", c.Style.State(string(h.State))},
		{"account", Deref(h.AccountID)},
		{"version", Deref(h.Version)},
		{"machine", strings.Join(machine, "/")},
		{"tiers", strings.Join(tiers, ", ")},
		{"kvm", kvm},
		{"capacity", fmt.Sprintf("%d vCPUs, %d MB memory, %d GB disk", h.Capacity.VCPUs, h.Capacity.MemoryMb, h.Capacity.DiskGb)},
		{"sandboxes", fmt.Sprint(h.Allocated.Sandboxes)},
	}
	rows = append(rows, hostMemoryFields(h.Memory)...)
	rows = append(rows,
		cli.Field{"labels", strings.Join(labels, ", ")},
		cli.Field{"joined", cli.Timestamp(h.JoinedAt)},
		cli.Field{"last seen", lastSeen},
	)
	return cli.Fields(c.Style, rows)
}

// ownHosts is the "Your own hosts (experimental)" section.
func ownHosts() cli.Section {
	return cli.Section{Title: "Your own hosts (experimental)", Commands: []*cli.Command{
		{
			Name: "hosts add", Summary: "Add a Linux machine of your own: only your account's sandboxes will run on it",
			Args: []cli.Arg{{Name: "name", Optional: true}},
			Flags: []cli.Flag{
				{Name: "label", Type: cli.String, Multiple: true, Value: "<K=V>", Description: "A label for the host; repeat it"},
				{Name: "expires", Type: cli.String, Value: "<minutes>", Description: "How long the token lasts, 5 to 10080; default 60"},
			},
			Details: "It prints a one-line command to run on the machine, as root. kantel-host installs, dials out to\n" +
				"Kantel and keeps that connection open: the machine needs no inbound port and may sit behind NAT.\n" +
				"The host joins the account you act in (your personal account, or --account <org>); from then on that\n" +
				"account's new sandboxes go on its own hosts, and no other account's ever do. The deployment must\n" +
				"have account hosts turned on (KANTEL_ACCOUNT_HOSTS=experimental).",
			Run: func(c *cli.Context) error {
				labels, err := Pairs(c.List("label"), "--label")
				if err != nil {
					return err
				}
				expires, err := Whole(c, "expires", 5)
				if err != nil {
					return err
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := AccountPtr(c)
				if err != nil {
					return err
				}
				var name *string
				if n, ok := c.Optional(0); ok {
					name = &n
				}
				var raw json.RawMessage
				token, err := client.CreateAccountJoinToken(c.Ctx, api.CreateAccountJoinTokenBody{
					Account: account, Name: name, Labels: labels, ExpiresInMinutes: expires,
				}, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, token, func() string {
					return strings.Join([]string{
						"Run this on the machine, as root, before " + cli.Timestamp(token.ExpiresAt) + ":",
						"",
						"  " + token.Command,
						"",
						"It joins account " + token.AccountID + "; the token works once. Then: kantel hosts list",
					}, "\n")
				})
				return nil
			},
		},
		{
			Name: "hosts list", Summary: "The hosts added to your account",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := AccountPtr(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				hosts, err := client.ListAccountHosts(c.Ctx, &api.ListAccountHostsQuery{Account: account}, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, hosts, func() string {
					if len(hosts.Items) == 0 {
						return "No hosts of your own. Add one with: kantel hosts add"
					}
					var rows [][]string
					for _, h := range hosts.Items {
						tiers := make([]string, len(h.Tiers))
						for i, t := range h.Tiers {
							tiers[i] = string(t)
						}
						seen := ""
						if h.LastSeenAt != nil {
							seen = cli.Ago(*h.LastSeenAt, now(c))
						}
						rows = append(rows, []string{h.ID, h.Name, c.Style.State(string(h.State)), strings.Join(tiers, ","),
							fmt.Sprint(h.Allocated.Sandboxes), seen})
					}
					return cli.Table(c.Style, []string{"ID", "NAME", "STATE", "TIERS", "SANDBOXES", "LAST SEEN"}, rows)
				})
				return nil
			},
		},
		{
			Name: "hosts info", Summary: "One of your hosts", Args: IDArg,
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				host, err := client.GetAccountHost(c.Ctx, c.Arg(0), api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, host, func() string { return describeHost(c, *host) })
				return nil
			},
		},
		{
			Name: "hosts drain", Summary: "Stop placing new sandboxes on one of your hosts (--off to take them again)", Args: IDArg,
			Flags: []cli.Flag{{Name: "off", Type: cli.Bool, Description: "Take new sandboxes again"}},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				host, err := client.UpdateAccountHost(c.Ctx, c.Arg(0), api.UpdateHostBody{Draining: api.Ptr(!c.Bool("off"))}, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, host, func() string { return fmt.Sprintf("%s (%s) is %s.", host.ID, host.Name, host.State) })
				return nil
			},
		},
		{
			Name: "hosts rm", Summary: "Remove one of your hosts: revoke its credential and close its connection (needs --yes)", Args: IDArg,
			Flags: []cli.Flag{{Name: "yes", Type: cli.Bool, Short: "y", Description: "Yes, remove it: it can't join again"}},
			Details: "Its sandboxes keep their disks on the machine but can't be reached. To take kantel-host off the\n" +
				"machine too, run on it: sudo kantel-host uninstall",
			Run: func(c *cli.Context) error {
				id := c.Arg(0)
				if !c.Bool("yes") {
					return cli.Usage(fmt.Sprintf("removing a host revokes its credential, and its sandboxes can't be reached. "+
						"To remove it, run: kantel hosts rm %s --yes (or kantel hosts drain %s stops new sandboxes going there)", id, id))
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				host, err := client.RemoveAccountHost(c.Ctx, id, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, host, func() string { return fmt.Sprintf("Removed %s (%s); it is %s.", host.ID, host.Name, host.State) })
				return nil
			},
		},
	}}
}
