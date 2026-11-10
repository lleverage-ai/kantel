package kantel

import "github.com/lleverage-ai/kantel/apps/cli/internal/cli"

// codingAgents is the "Coding agents" section. TODO(port): the commands of packages/cli/src/commands.ts's "Coding agents" section.
func codingAgents() cli.Section {
	return cli.Section{Title: "Coding agents"}
}
