package kantel

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// EventTypes are the account's events, which a webhook may send.
var EventTypes = []string{
	"sandbox.created", "sandbox.running", "sandbox.stopped", "sandbox.paused", "sandbox.error", "sandbox.degraded",
	"sandbox.recovered", "sandbox.oom_kill", "sandbox.deleted", "snapshot.saved", "snapshot.deleted",
}

// Signals are what an OpenTelemetry export sends.
var Signals = []string{"metrics", "logs"}

// urlHost is a URL's host (and port, other than its scheme's), as a browser's URL has it; false when it isn't one.
func urlHost(text string) (string, bool) {
	u, err := url.Parse(text)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", false
	}
	host := strings.ToLower(u.Host)
	if (u.Scheme == "https" && strings.HasSuffix(host, ":443")) || (u.Scheme == "http" && strings.HasSuffix(host, ":80")) {
		host = host[:strings.LastIndex(host, ":")]
	}
	return host, true
}

// events is the "Webhooks, events and telemetry" section.
func events() cli.Section {
	return cli.Section{Title: "Webhooks, events and telemetry", Commands: []*cli.Command{
		{
			Name: "webhook list", Summary: "The account's webhooks",
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
				hooks, err := client.ListWebhooks(c.Ctx, &api.ListWebhooksQuery{Account: account}, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, hooks, func() string {
					if len(hooks.Items) == 0 {
						return "No webhooks."
					}
					var rows [][]string
					for _, h := range hooks.Items {
						delivered := ""
						if last := h.LastDelivery; last != nil {
							ok := "failed"
							if last.Ok {
								ok = "ok"
							}
							delivered = ok + " " + cli.Ago(last.At, now(c))
						}
						state := "disabled"
						if h.Enabled {
							state = "enabled"
						}
						rows = append(rows, []string{h.ID, h.Name, h.URL, state, delivered})
					}
					return cli.Table(c.Style, []string{"ID", "NAME", "URL", "STATE", "LAST DELIVERY"}, rows)
				})
				return nil
			},
		},
		{
			Name: "webhook create", Summary: "Send the account's events to a URL; its signing secret is shown once",
			Args: []cli.Arg{{Name: "url"}},
			Flags: []cli.Flag{
				{Name: "event", Type: cli.String, Multiple: true, Value: "<type>", Choices: EventTypes, Description: "An event to send; default all"},
				{Name: "name", Type: cli.String, Value: "<name>", Description: "Default: the URL's host"},
			},
			Details: "Events: " + strings.Join(EventTypes, ", ") + ".",
			Run: func(c *cli.Context) error {
				picked, err := choicesOf(c, "event", EventTypes)
				if err != nil {
					return err
				}
				if picked == nil {
					picked = EventTypes
				}
				types := make([]api.EventType, len(picked))
				for i, t := range picked {
					types[i] = api.EventType(t)
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := AccountPtr(c)
				if err != nil {
					return err
				}
				u := c.Arg(0)
				name, ok := c.Str("name")
				if !ok {
					name = u
					if host, isURL := urlHost(u); isURL {
						name = host
					}
				}
				var raw json.RawMessage
				created, err := client.CreateWebhook(c.Ctx, api.CreateWebhookBody{Account: account, Name: name, URL: u, Events: types}, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, created, func() string {
					return strings.Join([]string{
						fmt.Sprintf("Created %s (%s).", created.Webhook.ID, created.Webhook.Name),
						"",
						"  " + created.Secret,
						"",
						"Its signing secret: store it now, it isn't shown again.",
					}, "\n")
				})
				return nil
			},
		},
		{
			Name: "webhook rm", Summary: "Delete a webhook", Args: IDArg,
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				if err := client.DeleteWebhook(c.Ctx, c.Arg(0)); err != nil {
					return err
				}
				c.Emit(nil, map[string]string{"deleted": c.Arg(0)}, func() string { return "Deleted " + c.Arg(0) + "." })
				return nil
			},
		},
		{
			Name: "webhook test", Summary: "Send a webhook a test delivery now", Args: IDArg,
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				delivery, err := client.TestWebhook(c.Ctx, c.Arg(0), api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, delivery, func() string {
					switch {
					case delivery.LastStatus != nil:
						return fmt.Sprintf("%s (%d)", delivery.State, *delivery.LastStatus)
					case delivery.LastError != nil:
						return fmt.Sprintf("%s (%s)", delivery.State, *delivery.LastError)
					}
					return string(delivery.State)
				})
				if delivery.State == api.WebhookDeliveryStateFailed {
					return cli.ExitCode(cli.ExitFailed)
				}
				return nil
			},
		},
		{
			Name: "events", Summary: "The account's events, newest first",
			Flags: []cli.Flag{
				{Name: "sandbox", Type: cli.String, Value: "<id>", Description: "Only this sandbox's"},
				{Name: "type", Type: cli.String, Value: "<type>", Description: "Only this type of event"},
				cursorFlag,
			},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := AccountPtr(c)
				if err != nil {
					return err
				}
				typ, err := choiceOf(c, "type", EventTypes)
				if err != nil {
					return err
				}
				query := &api.ListEventsQuery{Account: account, SandboxID: StrPtr(c, "sandbox"), Cursor: StrPtr(c, "cursor")}
				if typ != nil {
					t := api.EventType(*typ)
					query.Type = &t
				}
				var raw json.RawMessage
				page, err := client.ListEvents(c.Ctx, query, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, page, func() string {
					if len(page.Items) == 0 {
						return "No events."
					}
					var rows [][]string
					for _, e := range page.Items {
						d := e.Data
						var detail []string
						if d.Name != nil {
							detail = append(detail, *d.Name)
						}
						switch {
						case d.PreviousState != nil && d.State != nil:
							detail = append(detail, string(*d.PreviousState)+" to "+string(*d.State))
						case d.State != nil:
							detail = append(detail, string(*d.State))
						}
						if d.Reason != nil {
							detail = append(detail, *d.Reason)
						}
						on := Deref(e.SandboxID)
						if e.SandboxID == nil {
							on = Deref(e.SnapshotID)
						}
						rows = append(rows, []string{cli.Timestamp(e.CreatedAt), string(e.Type), on, strings.Join(detail, ", ")})
					}
					return cli.Table(c.Style, []string{"TIME", "TYPE", "ON", "DETAIL"}, rows) + More(page.NextCursor, "kantel events")
				})
				return nil
			},
		},
		{
			Name: "telemetry get", Summary: "Where the account's OpenTelemetry goes",
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
				telemetry, err := client.GetTelemetry(c.Ctx, &api.GetTelemetryQuery{Account: account}, api.Raw(&raw))
				var apiErr *api.Error
				if errors.As(err, &apiErr) && apiErr.Code == "not_found" {
					c.Emit(nil, nil, func() string { return "No OpenTelemetry export is set." })
					return nil
				}
				if err != nil {
					return err
				}
				c.Emit(raw, telemetry, func() string {
					lastExport := ""
					if last := telemetry.LastExport; last != nil {
						state := "ok"
						if !last.Ok {
							state = "failed"
							if last.Error != nil {
								state = "failed: " + *last.Error
							}
						}
						lastExport = state + " " + cli.Ago(last.At, now(c))
					}
					signals := make([]string, len(telemetry.Signals))
					for i, s := range telemetry.Signals {
						signals[i] = string(s)
					}
					return cli.Fields(c.Style, []cli.Field{
						{"endpoint", telemetry.Endpoint},
						{"signals", strings.Join(signals, ", ")},
						{"headers", strings.Join(telemetry.HeaderNames, ", ")},
						{"last export", lastExport},
					})
				})
				return nil
			},
		},
		{
			Name: "telemetry set", Summary: "Send the account's metrics and events to an OTLP/HTTP collector",
			Args: []cli.Arg{{Name: "endpoint"}},
			Flags: []cli.Flag{
				{Name: "header", Type: cli.String, Multiple: true, Value: "<K=V>", Description: "A header to send; repeat it"},
				{Name: "signal", Type: cli.String, Multiple: true, Value: "<metrics|logs>", Description: "What to send; default both"},
			},
			Run: func(c *cli.Context) error {
				headers, err := Pairs(c.List("header"), "--header")
				if err != nil {
					return err
				}
				picked, err := choicesOf(c, "signal", Signals)
				if err != nil {
					return err
				}
				var signals []api.PutTelemetryBodySignalsItem
				for _, s := range picked {
					signals = append(signals, api.PutTelemetryBodySignalsItem(s))
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := AccountPtr(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				saved, err := client.PutTelemetry(c.Ctx, api.PutTelemetryBody{Account: account, Endpoint: c.Arg(0), Headers: headers, Signals: signals}, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, saved, func() string {
					test := saved.Test
					answer := ""
					if test.Status != nil {
						answer += fmt.Sprintf(" (%d)", *test.Status)
					}
					if test.Error != nil {
						answer += ": " + *test.Error
					}
					if test.Ok {
						return "Saved; the collector took a test export" + answer + "."
					}
					return "Saved, but the collector refused a test export" + answer + "."
				})
				return nil
			},
		},
		{
			Name: "telemetry rm", Summary: "Stop sending OpenTelemetry",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := AccountPtr(c)
				if err != nil {
					return err
				}
				if err := client.DeleteTelemetry(c.Ctx, &api.DeleteTelemetryQuery{Account: account}); err != nil {
					return err
				}
				c.Emit(nil, map[string]bool{"deleted": true}, func() string { return "Removed the OpenTelemetry export." })
				return nil
			},
		},
	}}
}
