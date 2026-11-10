package kantel

import "github.com/lleverage-ai/kantel/apps/cli/internal/cli"

// snapshots is the "Snapshots" section. TODO(port): the commands of packages/cli/src/commands.ts's "Snapshots" section.
func snapshots() cli.Section {
	return cli.Section{Title: "Snapshots"}
}
