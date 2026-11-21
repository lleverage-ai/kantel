package kantel

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// follow reads a command's stdout and stderr by range (readCommandOutput), as their bytes from the start, rather than
// from the command's own stdout and stderr, which hold the first 1 MiB of each: so it shows all Kantel keeps (64 MiB a
// stream in a microVM on a current kantel-host), and every offset it reads from is one of those bytes. A gateway from
// before the route, or a sandbox that can't answer before any of a stream was read, leaves that stream to the record.

// followRetryPause is how long more waits before asking again, after a command's end, for a part Kantel couldn't
// answer for now.
const followRetryPause = 2 * time.Second

// outputTail is one stream of a followed command.
type outputTail struct {
	stream api.CommandStream
	// shown is how much of the stream has been written out: bytes read by range, or the record's, from its start.
	shown int
	// ranged: some of it was read by range.
	ranged bool
	// record: it is shown from the command's own stdout or stderr, as readCommandOutput couldn't answer before any of
	// it was read by range (a gateway from before it, or a sandbox that isn't running).
	record bool
	// stopped: readCommandOutput failed after some of it was read by range, so nothing more of it is shown.
	stopped bool
	// ended: the command has ended and all Kantel kept of the stream has been shown.
	ended bool
	// cut and limit: Kantel kept only the first limit bytes of the stream.
	cut   bool
	limit int64
}

// fromRecord writes what the command's own record of the stream has past what is shown, up to end, where the stream
// is shown from its record.
func (t *outputTail) fromRecord(w io.Writer, record string, end int) {
	if !t.record || end <= t.shown {
		return
	}
	fmt.Fprint(w, record[t.shown:end])
	t.shown = end
}

// more reads the stream on from what is shown, a part at a time, writing it to w, until it has caught up with what
// Kantel keeps. With final, the command has ended: a part Kantel can't answer for now is asked for again a few times.
func (t *outputTail) more(c *cli.Context, client *api.Client, sandboxID, commandID string, w io.Writer, final bool) {
	if t.record || t.stopped || t.ended {
		return
	}
	stream, encoding := t.stream, api.FileEncodingBase64
	tries := 0
	for {
		offset := int64(t.shown)
		ctx, cancel := context.WithTimeout(c.Ctx, followLook)
		part, err := client.ReadCommandOutput(ctx, sandboxID, commandID,
			&api.ReadCommandOutputQuery{Stream: &stream, Offset: &offset, Encoding: &encoding})
		deadline := ctx.Err() == context.DeadlineExceeded
		cancel()
		if err != nil {
			if c.Ctx.Err() != nil {
				return
			}
			why := transient(err)
			if deadline {
				why = fmt.Sprintf("Kantel didn't answer within %d s", int(followLook.Seconds()))
			}
			if why != "" && !final {
				// Asked again at the next look.
				return
			}
			if why != "" && tries < 5 {
				tries++
				if sleep(c, followRetryPause) == nil {
					continue
				}
			}
			t.failed(c, sandboxID, commandID, err)
			return
		}
		data, err := base64.StdEncoding.DecodeString(part.Content)
		if err != nil {
			t.failed(c, sandboxID, commandID, err)
			return
		}
		t.cut, t.limit = part.Truncated, part.Limit
		// A part that doesn't start where this one asked (never from Kantel) adds nothing, and ends this read.
		fresh := part.Offset == offset && len(data) > 0
		if fresh {
			t.ranged = true
			_, _ = w.Write(data)
			t.shown += len(data)
		}
		if !fresh || int64(t.shown) >= part.Size {
			t.ended = part.Ended && int64(t.shown) >= part.Size
			return
		}
	}
}

// failed is a read by range that can't go on: before any of the stream was read by range, it is shown from the
// command's record from then on; after, nothing more of it is shown. Either way it says why, unless it is a gateway
// from before readCommandOutput, whose record is all there is.
func (t *outputTail) failed(c *cli.Context, sandboxID, commandID string, err error) {
	var apiErr *api.Error
	isAPI := errors.As(err, &apiErr)
	if t.ranged {
		t.stopped = true
	} else {
		t.record = true
	}
	switch {
	case isAPI && apiErr.Code == "conflict":
		c.Note("kantel: the rest of its " + string(t.stream) + " is kept in the sandbox, which isn't running: resume it, " +
			"then kantel attach " + sandboxID + " " + commandID)
	case isAPI && apiErr.Status == 404 && apiErr.Code == "not_found" && !t.ranged:
		// A gateway from before readCommandOutput.
	default:
		c.Note("kantel: can't read the rest of its " + string(t.stream) + ": " + err.Error())
	}
}

// cutNote is what to say of output Kantel didn't keep all of: "" when it kept all it showed.
func cutNote(command *api.Command, tails ...*outputTail) string {
	for _, t := range tails {
		if !t.record && t.cut {
			return fmt.Sprintf("kantel: the %s was cut at %s", t.stream, mebibytes(t.limit))
		}
	}
	for _, t := range tails {
		if t.record && command.Truncated {
			return "kantel: the output was cut at 1 MiB"
		}
	}
	return ""
}

// mebibytes is a number of bytes in MiB where whole, such as 64 MiB.
func mebibytes(n int64) string {
	if n > 0 && n%(1<<20) == 0 {
		return fmt.Sprintf("%d MiB", n>>20)
	}
	return fmt.Sprintf("%d bytes", n)
}
