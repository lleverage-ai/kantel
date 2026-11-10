package cli

import (
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Colour is for a person at a terminal, and nothing for anyone else: a script, a pipe, a coding agent, --json and
// NO_COLOR all get plain text. It is quiet on purpose: headers and labels dimmed so the values stand out, a state in
// the colour of what it means, headings in bold, an error's prefix in red.

// Tone is one of the few styles the command lines use.
type Tone int

const (
	Bold Tone = iota
	Dim
	Red
	Green
	Yellow
	Cyan
)

var codes = map[Tone][2]int{Bold: {1, 22}, Dim: {2, 22}, Red: {31, 39}, Green: {32, 39}, Yellow: {33, 39}, Cyan: {36, 39}}

// ColourFor says whether a stream's text is coloured: a terminal, unless NO_COLOR, TERM=dumb or --json; FORCE_COLOR
// overrides (FORCE_COLOR=0 off).
func ColourFor(isTerminal bool, env Env, json bool) bool {
	if force, ok := env.Lookup("FORCE_COLOR"); ok && force != "" {
		return force != "0" && force != "false"
	}
	if json {
		return false
	}
	if v, _ := env.Lookup("NO_COLOR"); v != "" {
		return false
	}
	if v, _ := env.Lookup("TERM"); v == "dumb" {
		return false
	}
	return isTerminal
}

// Styler colours text for one stream, or leaves it plain.
type Styler struct{ On bool }

// Paint is text in tone, when the stream is coloured.
func (s Styler) Paint(t Tone, text string) string {
	if !s.On || text == "" {
		return text
	}
	c := codes[t]
	return fmt.Sprintf("\x1b[%dm%s\x1b[%dm", c[0], text, c[1])
}

// State is a state (of a sandbox, a host, a command) in the tone of what it means.
func (s Styler) State(state string) string {
	if t, ok := StateTone(state); ok {
		return s.Paint(t, state)
	}
	return state
}

var (
	greenStates  = regexp.MustCompile(`^(running|online|ready|active|exited 0|healthy)\b`)
	redStates    = regexp.MustCompile(`^(error|failed|killed|timed_out|revoked|degraded|offline|unhealthy)\b`)
	yellowStates = regexp.MustCompile(`^(starting|stopping|pausing|resuming|pending|draining|saving|creating)\b`)
	dimStates    = regexp.MustCompile(`^(stopped|paused|deleted|expired)\b`)
	colourCode   = regexp.MustCompile("\x1b\\[\\d+m")
)

// StateTone is the tone of a state: what is well green, what is wrong red, what waits yellow, what rests dim.
func StateTone(state string) (Tone, bool) {
	switch {
	case greenStates.MatchString(state):
		return Green, true
	case redStates.MatchString(state):
		return Red, true
	case yellowStates.MatchString(state):
		return Yellow, true
	case dimStates.MatchString(state):
		return Dim, true
	}
	return 0, false
}

// Plain is text without its colour.
func Plain(text string) string { return colourCode.ReplaceAllString(text, "") }

// Width is how many columns text takes, its colour aside.
func Width(text string) int { return utf8.RuneCountInString(Plain(text)) }

// Pad is text padded to width columns as it shows.
func Pad(text string, width int) string {
	if n := width - Width(text); n > 0 {
		return text + strings.Repeat(" ", n)
	}
	return text
}

var frames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// Spin shows a spinner on w while work runs (`⠹ Starting a microVM… 4s`) and clears it when it ends, when on; else
// it runs work and draws nothing.
func Spin[T any](w io.Writer, on bool, text string, work func() (T, error)) (T, error) {
	if !on {
		return work()
	}
	var mu sync.Mutex
	started := time.Now()
	frame := 0
	style := Styler{On: true}
	draw := func() {
		mu.Lock()
		defer mu.Unlock()
		elapsed := ""
		if s := int(time.Since(started).Seconds()); s >= 1 {
			elapsed = fmt.Sprintf(" %ds", s)
		}
		fmt.Fprintf(w, "\r\x1b[2K%s %s%s", style.Paint(Cyan, frames[frame%len(frames)]), text, style.Paint(Dim, elapsed))
		frame++
	}
	draw()
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(80 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				draw()
			}
		}
	}()
	value, err := work()
	close(stop)
	<-done
	fmt.Fprint(w, "\r\x1b[2K")
	return value, err
}
