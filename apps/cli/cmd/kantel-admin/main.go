// Command kantel-admin is the command for whoever runs a self-hosted Kantel: it installs and upgrades the control
// plane, changes its settings, reads its first compute key, and adds, drains and revokes the hosts that run sandboxes.
package main

import (
	"os"

	"github.com/lleverage-ai/kantel/apps/cli/internal/admin"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

func main() {
	os.Exit(cli.Run(admin.Program(admin.ThisMachine()), os.Args[1:], cli.DefaultIO()))
}
