package kantel

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// Version is the CLI's version, stamped at release (-ldflags -X …/kantel.Version=0.4.0).
var Version = "0.0.0"

// UserAgent is sent on every call.
func UserAgent() string { return "kantel-cli/" + Version }

// Settings are where the command finds Kantel and its credential: --url, --key (or --api-key) and --account, then
// KANTEL_URL, KANTEL_API_KEY and KANTEL_ACCOUNT, then the file kantel login writes. The account is as it was named.
func Settings(c *cli.Context) (cli.Settings, error) {
	if s, ok := c.Values["settings"].(cli.Settings); ok {
		return s, nil
	}
	stored, err := cli.ReadStored(c.IO.ConfigDir)
	if err != nil {
		return cli.Settings{}, err
	}
	key, _ := c.Str("key")
	if key == "" {
		key, _ = c.Str("api-key")
	}
	url, _ := c.Str("url")
	account, _ := c.Str("account")
	s, err := cli.Resolve(cli.Settings{URL: url, APIKey: key, Account: account}, c.IO.Env, stored, cli.DefaultURL)
	if err != nil {
		return cli.Settings{}, err
	}
	c.Values["settings"] = s
	return s, nil
}

// ClientFor is a client for settings.
func ClientFor(c *cli.Context, s cli.Settings) *api.Client {
	return &api.Client{BaseURL: s.URL, Token: s.APIKey, UserAgent: UserAgent(), HTTP: c.IO.HTTP, Sleep: c.IO.Sleep}
}

// Client is the command's client. It needs only the URL and the credential, never the account.
func Client(c *cli.Context) (*api.Client, error) {
	if client, ok := c.Values["client"].(*api.Client); ok {
		return client, nil
	}
	s, err := Settings(c)
	if err != nil {
		return nil, err
	}
	client := ClientFor(c, s)
	c.Values["client"] = client
	return client, nil
}

// isAccountID says whether ref is an account's ID (acc_…) rather than its name.
func isAccountID(ref string) bool { return strings.HasPrefix(ref, "acc_") }

// sameAccountName says whether account is the one name names: its name (case aside), or personal for a personal one.
func sameAccountName(a api.Account, name string) bool {
	wanted := strings.ToLower(strings.TrimSpace(name))
	if wanted == "personal" {
		return a.Kind == api.AccountKindPersonal
	}
	return strings.ToLower(a.Name) == wanted
}

// AccountNamed is the account of yours called name (case aside), or personal for your personal account.
func AccountNamed(c *cli.Context, client *api.Client, name string) (*api.Account, error) {
	list, err := client.ListAccounts(c.Ctx)
	if err != nil {
		return nil, err
	}
	var found []api.Account
	for _, a := range list.Items {
		if sameAccountName(a, name) {
			found = append(found, a)
		}
	}
	switch len(found) {
	case 0:
		return nil, cli.Fail(fmt.Sprintf(`you have no account called "%s": kantel org list shows them`, name))
	case 1:
		return &found[0], nil
	}
	ids := make([]string, len(found))
	for i, a := range found {
		ids[i] = a.ID
	}
	return nil, cli.Fail(fmt.Sprintf(`more than one account is called "%s": use its ID (%s)`, name, strings.Join(ids, ", ")))
}

// Account is the ID of the account the command acts in, from --account, KANTEL_ACCOUNT or `org use`, a name looked
// up; "" for the caller's default.
func Account(c *cli.Context) (string, error) {
	if id, ok := c.Values["account"].(string); ok {
		return id, nil
	}
	s, err := Settings(c)
	if err != nil {
		return "", err
	}
	id := s.Account
	if id != "" && !isAccountID(id) {
		client, err := Client(c)
		if err != nil {
			return "", err
		}
		a, err := AccountNamed(c, client, id)
		if err != nil {
			return "", err
		}
		id = a.ID
	}
	c.Values["account"] = id
	return id, nil
}

// AccountPtr is Account for a body's or a query's optional field.
func AccountPtr(c *cli.Context) (*string, error) {
	id, err := Account(c)
	if err != nil || id == "" {
		return nil, err
	}
	return &id, nil
}

// Hint says what to do about one of Kantel's errors, where there is something to do.
func Hint(e *api.Error) string {
	if e.Code == "unauthenticated" {
		return "Sign in with: kantel login (or set KANTEL_API_KEY)"
	}
	if e.Reason == "no_host_offers_size" {
		return "kantel sizes lists the sizes and shapes the hosts offer."
	}
	if e.Code == "conflict" {
		code, _ := e.Details["code"].(string)
		id, _ := e.Details["sandboxId"].(string)
		resume := "kantel resume " + id
		switch code {
		case "sandbox_starting":
			return "It is still starting: run the command again in a moment."
		case "sandbox_stopping":
			return "Once it has stopped, resume it with: " + resume
		case "sandbox_stopped", "sandbox_paused", "sandbox_error":
			return "Resume it with: " + resume
		}
		if hint, ok := e.Details["hint"].(string); ok && strings.HasPrefix(code, "sandbox_") {
			return hint
		}
	}
	return ""
}

// Values and checks.

// Choice is value if it is one of allowed, else a usage error naming them.
func Choice(value, what string, allowed ...string) (string, error) {
	for _, a := range allowed {
		if a == value {
			return value, nil
		}
	}
	return "", cli.Usage(fmt.Sprintf(`%s must be one of %s, not "%s"`, what, strings.Join(allowed, ", "), value))
}

var digits = regexp.MustCompile(`^\d+$`)

// Whole is a flag's whole number of at least min, nil when it wasn't given.
func Whole(c *cli.Context, flag string, min int64) (*int64, error) {
	value, ok := c.Str(flag)
	if !ok {
		return nil, nil
	}
	return WholeOf(value, "--"+flag, min)
}

// WholeOf is value as a whole number of at least min.
func WholeOf(value, what string, min int64) (*int64, error) {
	n, err := strconv.ParseInt(value, 10, 64)
	if !digits.MatchString(value) || err != nil || n < min {
		return nil, cli.Usage(fmt.Sprintf(`%s must be a whole number of at least %d, not "%s"`, what, min, value))
	}
	return &n, nil
}

// Pairs is key=value flags as a record; nil when there are none.
func Pairs(values []string, what string) (map[string]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	record := map[string]string{}
	for _, item := range values {
		k, v, ok := strings.Cut(item, "=")
		if !ok || k == "" {
			return nil, cli.Usage(fmt.Sprintf(`%s takes key=value, not "%s"`, what, item))
		}
		record[k] = v
	}
	return record, nil
}

// MinutesOrNever is a flag of minutes, or never (null); absent when it wasn't given.
func MinutesOrNever(c *cli.Context, flag string) (api.Nullable[int64], error) {
	value, ok := c.Str(flag)
	if !ok {
		return api.Nullable[int64]{}, nil
	}
	if value == "never" {
		return api.Null[int64](), nil
	}
	n, err := WholeOf(value, "--"+flag, 1)
	if err != nil {
		return api.Nullable[int64]{}, err
	}
	return api.Of(*n), nil
}

// StrPtr is a string flag as an optional field: nil when it wasn't given.
func StrPtr(c *cli.Context, flag string) *string {
	if v, ok := c.Str(flag); ok {
		return &v
	}
	return nil
}

// TruePtr is a boolean flag as an optional field: true when given, else absent.
func TruePtr(c *cli.Context, flag string) *bool {
	if c.Bool(flag) {
		return api.Ptr(true)
	}
	return nil
}

var plainWord = regexp.MustCompile(`^[\w@%+=:,./-]+$`)

// ShellQuote is one word for a POSIX shell, quoted only when it needs to be.
func ShellQuote(word string) string {
	if plainWord.MatchString(word) {
		return word
	}
	return "'" + strings.ReplaceAll(word, "'", `'\''`) + "'"
}

// CommandLine is what exec runs: one word as a shell command line, as it is; several as a command and its arguments.
func CommandLine(words []string) string {
	if len(words) == 1 {
		return words[0]
	}
	quoted := make([]string, len(words))
	for i, w := range words {
		quoted[i] = ShellQuote(w)
	}
	return strings.Join(quoted, " ")
}

// More is the line that fetches a list's next page, or nothing.
func More(cursor *string, command string) string {
	if cursor == nil {
		return ""
	}
	return "\n\nMore: " + command + " --cursor " + *cursor
}

// Deref is *p, or "".
func Deref[T ~string](p *T) string {
	if p == nil {
		return ""
	}
	return string(*p)
}
