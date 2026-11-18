// Command kantel is Kantel's command line and MCP server: sandboxes, commands, files, snapshots and keys from a
// terminal, a script or a coding agent.
package main

import (
	"os"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
	"github.com/lleverage-ai/kantel/apps/cli/internal/kantel"
)

func main() {
	os.Exit(cli.Run(kantel.Program(), os.Args[1:], cli.DefaultIO()))
}
