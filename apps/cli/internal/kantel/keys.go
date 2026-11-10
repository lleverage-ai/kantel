package kantel

import "github.com/lleverage-ai/kantel/apps/cli/internal/cli"

// keys is the "API keys and personal tokens" section. TODO(port): the commands of packages/cli/src/commands.ts's "API keys and personal tokens" section.
func keys() cli.Section {
	return cli.Section{Title: "API keys and personal tokens"}
}
