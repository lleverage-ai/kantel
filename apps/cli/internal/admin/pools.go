package admin

import (
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// The pools: sets of the shared hosts, each host in one.

var poolArg = []cli.Arg{{Name: "pool"}}

func poolTable(c *cli.Context, pools []api.Pool) string {
	var rows [][]string
	for _, p := range pools {
		def := ""
		if p.Default {
			def = "yes"
		}
		rows = append(rows, []string{p.ID, p.Name, def, strconv.FormatInt(p.Hosts, 10)})
	}
	return cli.Table(c.Style, []string{"ID", "NAME", "DEFAULT", "HOSTS"}, rows)
}

// poolCall runs a call that answers a pool, and prints it as told.
func poolCall(c *cli.Context, call func(client *api.Client, raw *json.RawMessage) (*api.Pool, error),
	human func(api.Pool) string) error {
	client, err := Client(c)
	if err != nil {
		return err
	}
	var raw json.RawMessage
	pool, err := call(client, &raw)
	if err != nil {
		return err
	}
	c.Emit(raw, pool, func() string { return human(*pool) })
	return nil
}

func pools() cli.Section {
	return cli.Section{Title: "Pools", Commands: []*cli.Command{
		{
			Name:    "pool list",
			Summary: "The pools of shared hosts: sets of them, each host in one",
			Details: "A sandbox goes on a host of a pool, and a host joins the default pool unless its token names another.",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				list, err := client.ListPools(c.Ctx, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, list, func() string { return poolTable(c, list.Items) })
				return nil
			},
		},
		{
			Name:    "pool add",
			Summary: "Make an empty pool",
			Args:    []cli.Arg{{Name: "name"}},
			Details: "Put hosts in it with host add --pool <name>, or host move <hostId> <name>.",
			Run: func(c *cli.Context) error {
				return poolCall(c, func(client *api.Client, raw *json.RawMessage) (*api.Pool, error) {
					return client.CreatePool(c.Ctx, api.CreatePoolBody{Name: c.Arg(0)}, api.Raw(raw))
				}, func(p api.Pool) string { return p.ID + " " + p.Name })
			},
		},
		{
			Name:    "pool rename",
			Summary: "Rename a pool",
			Args:    []cli.Arg{{Name: "pool"}, {Name: "name"}},
			Run: func(c *cli.Context) error {
				name := c.Arg(1)
				return poolCall(c, func(client *api.Client, raw *json.RawMessage) (*api.Pool, error) {
					return client.UpdatePool(c.Ctx, c.Arg(0), api.UpdatePoolBody{Name: &name}, api.Raw(raw))
				}, func(p api.Pool) string { return p.ID + " " + p.Name })
			},
		},
		{
			Name:    "pool default",
			Summary: "Make a pool the default: where hosts join and sandboxes go, naming none",
			Args:    poolArg,
			Run: func(c *cli.Context) error {
				return poolCall(c, func(client *api.Client, raw *json.RawMessage) (*api.Pool, error) {
					return client.UpdatePool(c.Ctx, c.Arg(0), api.UpdatePoolBody{Default: api.Ptr(true)}, api.Raw(raw))
				}, func(p api.Pool) string { return fmt.Sprintf("%s %s is the default", p.ID, p.Name) })
			},
		},
		{
			Name:    "pool rm",
			Summary: "Delete a pool: an empty one that isn't the default",
			Args:    poolArg,
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				if err := client.DeletePool(c.Ctx, c.Arg(0)); err != nil {
					return err
				}
				c.Emit(nil, map[string]string{"deleted": c.Arg(0)}, func() string { return "deleted " + c.Arg(0) })
				return nil
			},
		},
	}}
}
