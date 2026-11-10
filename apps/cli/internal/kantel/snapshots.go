package kantel

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

var (
	// snapshotLabelFlag is snapshot take's and snapshot save's --label.
	snapshotLabelFlag = cli.Flag{Name: "label", Type: cli.String, Multiple: true, Value: "<k=v>",
		Description: "A label, such as git.base=<commit>; repeat for more"}
	// snapshotMemoryFlag is snapshot take's and snapshot save's --memory.
	snapshotMemoryFlag = cli.Flag{Name: "memory", Type: cli.Bool,
		Description: "Keep a running microVM's memory too, so a sandbox made from it carries on where it was, on the same size only; " +
			"default the disk alone"}
	snapshotDescriptionFlag = cli.Flag{Name: "description", Type: cli.String, Value: "<text>", Description: "What it holds"}
	minMemoryGB             = regexp.MustCompile(`^\d+(\.\d+)?$`)
)

// snapshotKindOf is a snapshot's kind: `saved`, or `saved, memory` when it holds its sandbox's memory.
func snapshotKindOf(s api.Snapshot) string {
	if s.Memory {
		return string(s.Kind) + ", memory"
	}
	return string(s.Kind)
}

// DescribeSnapshot is one snapshot, for kantel snapshot info: what it holds, and when its state was taken and saved.
func DescribeSnapshot(c *cli.Context, s api.Snapshot) string {
	var labels []string
	for _, k := range sortedKeys(s.Labels) {
		labels = append(labels, k+"="+s.Labels[k])
	}
	machine := []string{string(s.SandboxType)}
	if s.Size != nil {
		machine = append(machine, string(*s.Size))
	}
	if r := s.Resources; r != nil {
		machine = append(machine, fmt.Sprintf("%d vCPU, %d MB, %d GB", r.VCPUs, r.MemoryMb, r.DiskGb))
	}
	at := func(t int64) string { return cli.Timestamp(t) + " (" + cli.Ago(t, now(c)) + ")" }
	base := ""
	if b := s.Base; b != nil {
		base = b.Image
		if b.Version != nil {
			base = *b.Version
		}
		if b.Outdated {
			base += " (outdated)"
		}
	}
	size := ""
	if s.SizeBytes != nil {
		size = cli.Bytes(float64(*s.SizeBytes))
	}
	uses := ""
	if s.Uses != nil {
		uses = strconv.FormatInt(*s.Uses, 10)
	}
	// The state's own time, where a save copied an older snapshot; else it is the save's.
	taken := ""
	if s.TakenAt != nil && *s.TakenAt != s.CreatedAt {
		taken = at(*s.TakenAt)
	}
	createdKey := "taken"
	if s.Kind == api.SnapshotKindSaved {
		createdKey = "saved"
	}
	expires := ""
	if s.ExpiresAt != nil {
		expires = cli.Until(*s.ExpiresAt, now(c))
	}
	return cli.Fields(c.Style, []cli.Field{
		{"id", s.ID},
		{"name", Deref(s.Name)},
		{"kind", snapshotKindOf(s)},
		{"state", c.Style.State(string(s.State))},
		{"description", Deref(s.Description)},
		{"labels", strings.Join(labels, ", ")},
		{"sandbox", Deref(s.SandboxID)},
		{"machine", strings.Join(machine, ", ")},
		{"base", base},
		{"size", size},
		{"uses", uses},
		{"taken", taken},
		{createdKey, at(s.CreatedAt)},
		{"expires", expires},
	})
}

// fileListTable is a directory's listing: its kind, size, age and name, a directory's with a slash.
func fileListTable(c *cli.Context, list api.FileList) string {
	if len(list.Items) == 0 {
		return list.Path + " is empty."
	}
	var rows [][]string
	for _, e := range list.Items {
		kind, size, name := "file", "", e.Name
		switch e.Kind {
		case api.FileEntryKindDirectory:
			kind, name = "dir", e.Name+"/"
		case api.FileEntryKindSymlink:
			kind = "link"
		default:
			size = cli.Bytes(float64(e.Size))
		}
		modified := ""
		if e.ModifiedAt != nil {
			modified = cli.Ago(*e.ModifiedAt, now(c))
		}
		rows = append(rows, []string{kind, size, modified, name})
	}
	return cli.Table(c.Style, []string{"KIND", "SIZE", "MODIFIED", "NAME"}, rows)
}

func snapshots() cli.Section {
	return cli.Section{Title: "Snapshots", Commands: []*cli.Command{
		{
			Name: "snapshot list", Summary: "Saved snapshots, or one sandbox's history",
			Args: []cli.Arg{{Name: "sandboxId", Optional: true}},
			Flags: []cli.Flag{
				{Name: "sandbox", Type: cli.String, Value: "<id>", Description: "Only this sandbox's snapshots"},
				{Name: "saved", Type: cli.Bool, Description: "Only saved snapshots"},
				cursorFlag,
			},
			Run: func(c *cli.Context) error {
				sandboxID, given := c.Optional(0)
				flagged, flaggedGiven := c.Str("sandbox")
				if given && flaggedGiven && sandboxID != flagged {
					return cli.Usage("give the sandbox once: kantel snapshot list <id>")
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := AccountPtr(c)
				if err != nil {
					return err
				}
				query := &api.ListSnapshotsQuery{Account: account, Cursor: StrPtr(c, "cursor")}
				if given {
					query.SandboxID = &sandboxID
				} else if flaggedGiven {
					query.SandboxID = &flagged
				}
				if c.Bool("saved") {
					saved := api.SnapshotKindSaved
					query.Kind = &saved
				}
				var raw json.RawMessage
				page, err := client.ListSnapshots(c.Ctx, query, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, page, func() string {
					if len(page.Items) == 0 {
						return "No snapshots."
					}
					var rows [][]string
					for _, s := range page.Items {
						size := ""
						if s.SizeBytes != nil {
							size = cli.Bytes(float64(*s.SizeBytes))
						}
						rows = append(rows, []string{s.ID, Deref(s.Name), snapshotKindOf(s), c.Style.State(string(s.State)),
							Deref(s.SandboxID), size, cli.Ago(s.CreatedAt, now(c))})
					}
					header := []string{"ID", "NAME", "KIND", "STATE", "SANDBOX", "SIZE", "CREATED"}
					return cli.Table(c.Style, header, rows) + More(page.NextCursor, "kantel snapshot list")
				})
				return nil
			},
		},
		{
			Name:    "snapshot info",
			Summary: "A snapshot's details: what it holds, its labels, and when it was taken and saved",
			Args:    []cli.Arg{{Name: "snapshot"}},
			Details: "Give a snapshot's ID, or a saved snapshot's name.",
			Run:     snapshotInfo,
		},
		{
			Name: "snapshot take", Summary: "Add a snapshot of a sandbox's disk to its history now", Args: IDArg,
			Flags: []cli.Flag{snapshotDescriptionFlag, snapshotLabelFlag, snapshotMemoryFlag},
			Run: func(c *cli.Context) error {
				labels, err := Pairs(c.List("label"), "--label")
				if err != nil {
					return err
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				snapshot, err := client.TakeSnapshot(c.Ctx, c.Arg(0), api.TakeSnapshotBody{
					Description: StrPtr(c, "description"), Labels: labels, Memory: TruePtr(c, "memory"),
				}, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, snapshot, func() string { return snapshot.ID + " " + string(snapshot.State) })
				return nil
			},
		},
		{
			Name:    "snapshot save",
			Summary: "Keep a sandbox's state under a name, to start new sandboxes from",
			Args:    []cli.Arg{{Name: "sandboxId"}, {Name: "name"}},
			Flags: []cli.Flag{
				{Name: "replace", Type: cli.Bool, Description: "Replace a saved snapshot of the same name"},
				snapshotDescriptionFlag,
				snapshotLabelFlag,
				{Name: "snapshot", Type: cli.String, Value: "<id>", Description: "Save this snapshot of its history; default now"},
				snapshotMemoryFlag,
				{Name: "min-memory", Type: cli.String, Value: "<GB>",
					Description: "The least memory a sandbox made from it may have, such as 16 (0: none; a replace keeps its own)"},
			},
			Details: "--min-memory makes Kantel refuse a sandbox made from it with less memory, before it starts one that\n" +
				"would run out part of the way through: kantel snapshot save <id> monorepo-checks --min-memory 16, then\n" +
				"kantel new --from monorepo-checks --vcpus 8 --memory 16.",
			Examples: []cli.Example{
				{What: "Keep a sandbox's disk under a name, to start others from",
					Line: "kantel snapshot save sbx_4kq9x2mt monorepo-ci --label git.base=$(git rev-parse HEAD)"},
				{What: "Replace it after installing more", Line: "kantel snapshot save sbx_4kq9x2mt monorepo-ci --replace"},
			},
			Run: func(c *cli.Context) error {
				body := api.SaveSnapshotBody{
					SandboxID: c.Arg(0), Name: c.Arg(1), SnapshotID: StrPtr(c, "snapshot"),
					Description: StrPtr(c, "description"), Replace: TruePtr(c, "replace"), Memory: TruePtr(c, "memory"),
				}
				if minMemory, ok := c.Str("min-memory"); ok {
					gb, err := strconv.ParseFloat(minMemory, 64)
					if !minMemoryGB.MatchString(minMemory) || err != nil || gb < 0 {
						return cli.Usage(`--min-memory is in GB, such as 16 or 0.5, not "` + minMemory + `"`)
					}
					mb := int64(math.Round(gb * 1024))
					body.MinMemoryMb = &mb
				}
				labels, err := Pairs(c.List("label"), "--label")
				if err != nil {
					return err
				}
				body.Labels = labels
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				snapshot, err := client.SaveSnapshot(c.Ctx, body, api.Raw(&raw))
				if err != nil {
					return err
				}
				name := snapshot.ID
				if snapshot.Name != nil {
					name = *snapshot.Name
				}
				c.Emit(raw, snapshot, func() string {
					return fmt.Sprintf("Saved %s (%s).\n  Start from it:  kantel sandbox create --from %s", name, snapshot.ID, name)
				})
				return nil
			},
		},
		{
			Name: "snapshot files", Summary: "List a directory in a snapshot",
			Args:  []cli.Arg{{Name: "snapshotId"}, {Name: "path", Optional: true}},
			Flags: []cli.Flag{cursorFlag},
			Run: func(c *cli.Context) error {
				snapshotID := c.Arg(0)
				query := &api.ListSnapshotFilesQuery{Cursor: StrPtr(c, "cursor")}
				if path, ok := c.Optional(1); ok {
					query.Path = &path
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				list, err := client.ListSnapshotFiles(c.Ctx, snapshotID, query, api.Raw(&raw))
				if err != nil {
					return err
				}
				next := More(list.NextCursor, "kantel snapshot files "+snapshotID+" "+list.Path)
				c.Emit(raw, list, func() string { return fileListTable(c, *list) + next })
				return nil
			},
		},
		{
			Name: "snapshot rm", Summary: "Delete a snapshot", Args: []cli.Arg{{Name: "snapshotId"}},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				if err := client.DeleteSnapshot(c.Ctx, c.Arg(0)); err != nil {
					return err
				}
				c.Emit(nil, map[string]string{"deleted": c.Arg(0)}, func() string { return "Deleted " + c.Arg(0) + "." })
				return nil
			},
		},
	}}
}

// snapshotInfo is snapshot info: by ID first, as --from takes one, then by a saved snapshot's name.
func snapshotInfo(c *cli.Context) error {
	client, err := Client(c)
	if err != nil {
		return err
	}
	wanted := c.Arg(0)
	show := func(id string) error {
		var raw json.RawMessage
		snapshot, err := client.GetSnapshot(c.Ctx, id, api.Raw(&raw))
		if err != nil {
			return err
		}
		c.Emit(raw, snapshot, func() string { return DescribeSnapshot(c, *snapshot) })
		return nil
	}
	// A saved name may start with snap_ too, so not found falls through to the names.
	if strings.HasPrefix(wanted, "snap_") {
		err := show(wanted)
		var apiErr *api.Error
		if err == nil || !errors.As(err, &apiErr) || apiErr.Code != "not_found" {
			return err
		}
	}
	// A name: the account's saved snapshots, page by page.
	account, err := AccountPtr(c)
	if err != nil {
		return err
	}
	saved := api.SnapshotKindSaved
	var cursor *string
	for {
		page, err := client.ListSnapshots(c.Ctx, &api.ListSnapshotsQuery{Account: account, Kind: &saved, Cursor: cursor})
		if err != nil {
			return err
		}
		for _, s := range page.Items {
			if s.Name != nil && *s.Name == wanted {
				return show(s.ID)
			}
		}
		if page.NextCursor == nil {
			break
		}
		cursor = page.NextCursor
	}
	return cli.Fail(fmt.Sprintf(`there is no snapshot %s, or saved one called "%s": kantel snapshot list shows them`, wanted, wanted))
}
