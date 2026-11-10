package kantel

import "github.com/lleverage-ai/kantel/apps/cli/internal/cli"

// access is the "Ports, SSH, desktop and browser" section. TODO(port): the commands of packages/cli/src/commands.ts's "Ports, SSH, desktop and browser" section.
func access() cli.Section {
	return cli.Section{Title: "Ports, SSH, desktop and browser"}
}
