package kantel

import "github.com/lleverage-ai/kantel/apps/cli/internal/cli"

// accounts is the "Accounts and organisations" section. TODO(port): the commands of packages/cli/src/commands.ts's "Accounts and organisations" section.
func accounts() cli.Section {
	return cli.Section{Title: "Accounts and organisations"}
}
