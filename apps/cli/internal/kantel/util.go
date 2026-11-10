package kantel

import (
	"context"
	"sort"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

func withTimeout(c *cli.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(c.Ctx, d)
}

// now is the run's clock.
func now(c *cli.Context) time.Time {
	if c.IO.Now != nil {
		return c.IO.Now()
	}
	return time.Now()
}

func sortStrings(s []string) { sort.Strings(s) }
