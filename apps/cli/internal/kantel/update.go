package kantel

import "github.com/lleverage-ai/kantel/apps/cli/internal/cli"

// updateCommand is `kantel update`. TODO(port): download the release's binary for this platform, check it against
// SHA256SUMS and replace this one in place.
func updateCommand() *cli.Command {
	return &cli.Command{
		Name:    "update",
		Summary: "Update kantel to the latest release, or to --version",
		Run:     func(c *cli.Context) error { return cli.Fail("not yet") },
	}
}
