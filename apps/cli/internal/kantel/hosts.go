package kantel

import "github.com/lleverage-ai/kantel/apps/cli/internal/cli"

// ownHosts is the "Your own hosts (experimental)" section. TODO(port): the commands of packages/cli/src/commands.ts's "Your own hosts (experimental)" section.
func ownHosts() cli.Section {
	return cli.Section{Title: "Your own hosts (experimental)"}
}
