package kantel

import "github.com/lleverage-ai/kantel/apps/cli/internal/cli"

// environments is the "Environments and egress" section. TODO(port): the commands of packages/cli/src/commands.ts's "Environments and egress" section.
func environments() cli.Section {
	return cli.Section{Title: "Environments and egress"}
}
