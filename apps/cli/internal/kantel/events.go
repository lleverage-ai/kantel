package kantel

import "github.com/lleverage-ai/kantel/apps/cli/internal/cli"

// events is the "Webhooks, events and telemetry" section. TODO(port): the commands of packages/cli/src/commands.ts's "Webhooks, events and telemetry" section.
func events() cli.Section {
	return cli.Section{Title: "Webhooks, events and telemetry"}
}
