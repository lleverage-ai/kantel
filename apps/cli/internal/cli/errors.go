package cli

import (
	"errors"
	"sort"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
)

// The exit codes kantel and kantel-admin keep to: 0 it worked, 1 it failed, 2 it was used wrongly (nothing was done),
// 4 it needs a credential that works. exec and attach exit with the command's own code instead.
const (
	ExitOK     = 0
	ExitFailed = 1
	ExitUsage  = 2
	ExitSignIn = 4
)

// Error is a failure the CLI reports as `<program>: <message>`, with a code a script can test and a hint.
type Error struct {
	Message string
	// Code is what went wrong, as a word: usage, unreachable, failed, or the command's own.
	Code string
	Hint string
	Exit int
}

func (e *Error) Error() string { return e.Message }

// Fail is a failure that exits 1.
func Fail(message string) *Error { return &Error{Message: message, Code: "failed", Exit: ExitFailed} }

// Usage is a usage mistake (a missing argument, an unknown flag, a bad value) that exits 2 with the usage line.
func Usage(message string) *Error { return &Error{Message: message, Code: "usage", Exit: ExitUsage} }

// UsageHint is a usage mistake with what to do about it.
func UsageHint(message, hint string) *Error {
	return &Error{Message: message, Code: "usage", Hint: hint, Exit: ExitUsage}
}

// ExitCode is a command's own exit, with nothing more to say (exec's, the command's).
type ExitCode int

func (e ExitCode) Error() string { return "exit" }

// Failure is a failure as both CLIs report it.
type Failure struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Hint    string         `json:"hint,omitempty"`
	Reason  string         `json:"reason,omitempty"`
	Details map[string]any `json:"details,omitempty"`
	Status  int            `json:"status,omitempty"`
	Exit    int            `json:"exitCode"`
}

// FailureOf is err as a Failure, with hint for Kantel's errors where the program has one.
func FailureOf(err error, hint func(*api.Error) string) Failure {
	var apiErr *api.Error
	var cliErr *Error
	var unreachable *api.UnreachableError
	switch {
	case errors.As(err, &apiErr):
		f := Failure{Code: apiErr.Code, Message: apiErr.Message, Reason: apiErr.Reason, Details: apiErr.Details,
			Status: apiErr.Status, Exit: ExitFailed}
		if hint != nil {
			f.Hint = hint(apiErr)
		}
		if apiErr.Code == "unauthenticated" {
			f.Exit = ExitSignIn
		}
		return f
	case errors.As(err, &cliErr):
		return Failure{Code: cliErr.Code, Message: cliErr.Message, Hint: cliErr.Hint, Exit: cliErr.Exit}
	case errors.As(err, &unreachable):
		return Failure{Code: "unreachable", Message: unreachable.Error(), Exit: ExitFailed}
	}
	return Failure{Code: "failed", Message: err.Error(), Exit: ExitFailed}
}

// FailureText is a failure as stderr shows it: with --json one line of JSON, {"error": {…}}, so a script reads the
// code rather than prose; else `<program>: <code>: <message>` (Kantel's errors) or `<program>: <message>`, and the
// hint and the usage line after it.
func FailureText(program string, f Failure, asJSON bool, usage string, s Styler) string {
	if asJSON {
		line := Marshal(map[string]Failure{"error": f}, "")
		return string(line) + "\n"
	}
	code := ""
	if f.Status != 0 {
		code = s.Paint(Bold, f.Code+":") + " "
	}
	reason := ""
	if f.Reason != "" {
		reason = s.Paint(Dim, " (reason: "+f.Reason+")")
	}
	lines := []string{s.Paint(Red, program+":") + " " + code + f.Message + reason}
	if f.Hint != "" {
		lines = append(lines, s.Paint(Dim, f.Hint))
	}
	if usage != "" {
		lines = append(lines, s.Paint(Dim, "Usage: "+usage))
	}
	return strings.Join(lines, "\n") + "\n"
}

// WantsJSON says whether argv asks for JSON: --json (or --json=true) before any --.
func WantsJSON(argv []string) bool {
	for _, w := range argv {
		if w == "--" {
			return false
		}
		if w == "--json" || w == "--json=true" {
			return true
		}
	}
	return false
}

// Nearest is the candidates within a typo of word, nearest first, for "did you mean": one edit for a short word and
// two for a longer one, where an edit adds, drops, changes or swaps a letter; a candidate word begins also counts.
func Nearest(word string, candidates []string, limit int) []string {
	allowed := 2.0
	if len([]rune(word)) <= 4 {
		allowed = 1
	}
	type scored struct {
		name string
		d    float64
	}
	seen := map[string]bool{}
	var found []scored
	for _, c := range candidates {
		if c == word || seen[c] {
			continue
		}
		seen[c] = true
		d := float64(editDistance(strings.ToLower(word), strings.ToLower(c)))
		if len(word) >= 3 && strings.HasPrefix(c, word) {
			d = 0.5
		}
		if d <= allowed {
			found = append(found, scored{c, d})
		}
	}
	sort.Slice(found, func(i, j int) bool {
		if found[i].d != found[j].d {
			return found[i].d < found[j].d
		}
		return found[i].name < found[j].name
	})
	var out []string
	for i := 0; i < len(found) && i < limit; i++ {
		out = append(out, found[i].name)
	}
	return out
}

// editDistance is the optimal string alignment distance: adds, drops, changes and swaps of neighbours.
func editDistance(a, b string) int {
	x, y := []rune(a), []rune(b)
	d := make([][]int, len(x)+1)
	for i := range d {
		d[i] = make([]int, len(y)+1)
		d[i][0] = i
	}
	for j := range d[0] {
		d[0][j] = j
	}
	for i := 1; i <= len(x); i++ {
		for j := 1; j <= len(y); j++ {
			cost := 1
			if x[i-1] == y[j-1] {
				cost = 0
			}
			d[i][j] = min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+cost)
			if i > 1 && j > 1 && x[i-1] == y[j-2] && x[i-2] == y[j-1] {
				d[i][j] = min(d[i][j], d[i-2][j-2]+1)
			}
		}
	}
	return d[len(x)][len(y)]
}

// DidYouMean is ` Did you mean x?` or ` Did you mean x, y or z?`, or nothing.
func DidYouMean(options []string) string {
	switch len(options) {
	case 0:
		return ""
	case 1:
		return " Did you mean " + options[0] + "?"
	}
	return " Did you mean " + strings.Join(options[:len(options)-1], ", ") + " or " + options[len(options)-1] + "?"
}
