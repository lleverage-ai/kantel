package kantel

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// Environments and egress: `--bind` and grant parsing, and the human output of `kantel env show` and `kantel egress`.
// A protected variable's value is never printed: Kantel doesn't answer one, and should it ever, WithoutProtectedValues
// drops it before anything is shown.

var httpMethods = []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"}

const hostLabel = `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?`

// hostPattern is `api.github.com`, or `*.example.com` for the names under it.
var hostPattern = regexp.MustCompile(`^(\*\.)?(` + hostLabel + `\.)*` + hostLabel + `$`)

func unique(items []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, item := range items {
		if !seen[item] {
			seen[item] = true
			out = append(out, item)
		}
	}
	return out
}

func isHTTPMethod(word string) bool {
	for _, m := range httpMethods {
		if m == word {
			return true
		}
	}
	return false
}

// hostName is a host as Kantel takes it, in lower case: it refuses a URL, a port and anything that isn't a name.
func hostName(text, what string) (string, error) {
	if strings.Contains(text, "://") {
		return "", cli.Usage(fmt.Sprintf(`give %s as a host, not a URL: drop the scheme from "%s"`, what, text))
	}
	host := strings.ToLower(text)
	if strings.Contains(host, ":") {
		return "", cli.Usage(fmt.Sprintf(`give %s with no port, not "%s"`, what, text))
	}
	if !hostPattern.MatchString(host) {
		return "", cli.Usage(fmt.Sprintf(`"%s" isn't a host name, such as api.github.com or *.example.com`, text))
	}
	return host, nil
}

// parseBinding is one --bind: `<host>[/path-prefix][:METHOD,METHOD]`, such as `api.github.com`,
// `api.github.com/repos/:GET` or `api.openai.com/v1/:POST,GET`. A path prefix of / is every path. A colon followed by
// anything other than HTTP methods stays part of the path, as in /v1/models/m:generate.
func parseBinding(text string) (api.DestinationBinding, error) {
	trimmed := strings.TrimSpace(text)
	if strings.Contains(trimmed, "://") {
		return api.DestinationBinding{}, cli.Usage(`--bind takes a host, not a URL: drop the scheme from "` + text + `"`)
	}
	rest := trimmed
	var methods []string
	if colon := strings.LastIndex(rest, ":"); colon != -1 {
		words := strings.Split(rest[colon+1:], ",")
		all := true
		for i, w := range words {
			words[i] = strings.ToUpper(strings.TrimSpace(w))
			if !isHTTPMethod(words[i]) {
				all = false
			}
		}
		if all {
			methods = unique(words)
			rest = rest[:colon]
		}
	}
	hostPart, pathPart, hasPath := strings.Cut(rest, "/")
	host, err := hostName(hostPart, "--bind's host")
	if err != nil {
		return api.DestinationBinding{}, err
	}
	b := api.DestinationBinding{Host: host, Methods: methods}
	if hasPath {
		p := "/" + pathPart
		if strings.ContainsAny(p, "?#") {
			return api.DestinationBinding{}, cli.Usage(`--bind takes a path prefix with no query or fragment, not "` + text + `"`)
		}
		if p != "/" {
			b.PathPrefixes = []string{p}
		}
	}
	return b, nil
}

// mergeBindings is --binds for the same host and methods as one binding with all their path prefixes; one with no
// prefix (every path) stays so.
func mergeBindings(bindings []api.DestinationBinding) []api.DestinationBinding {
	keyOf := func(b api.DestinationBinding) string {
		methods := append([]string(nil), b.Methods...)
		sortStrings(methods)
		return b.Host + " " + strings.Join(methods, ",")
	}
	var merged []api.DestinationBinding
	for _, b := range bindings {
		index := -1
		for i, m := range merged {
			if keyOf(m) == keyOf(b) {
				index = i
			}
		}
		if index == -1 {
			merged = append(merged, b)
			continue
		}
		existing := merged[index]
		var prefixes []string
		if existing.PathPrefixes != nil && b.PathPrefixes != nil {
			prefixes = unique(append(append([]string{}, existing.PathPrefixes...), b.PathPrefixes...))
		}
		merged[index] = api.DestinationBinding{Host: existing.Host, PathPrefixes: prefixes, Methods: existing.Methods}
	}
	return merged
}

// bindingTexts is a binding as --bind takes it: one per path prefix, such as `api.openai.com/v1/:POST,GET`.
func bindingTexts(b api.DestinationBinding) []string {
	methods := ""
	if len(b.Methods) > 0 {
		methods = ":" + strings.Join(b.Methods, ",")
	}
	prefixes := b.PathPrefixes
	if len(prefixes) == 0 {
		prefixes = []string{""}
	}
	out := make([]string, len(prefixes))
	for i, p := range prefixes {
		out[i] = b.Host + p + methods
	}
	return out
}

func bindingsText(bindings []api.DestinationBinding) string {
	var all []string
	for _, b := range bindings {
		all = append(all, bindingTexts(b)...)
	}
	return strings.Join(all, ", ")
}

var methodWord = regexp.MustCompile(`^[A-Z]+$`)

// parseGrant is a grant from the command line: `allow|deny <host>`, --method and --path.
func parseGrant(action, hostText string, methodTexts, pathTexts []string) (api.EgressGrantInput, error) {
	if action != "allow" && action != "deny" {
		return api.EgressGrantInput{}, cli.Usage(`a grant is allow or deny, not "` + action + `"`)
	}
	host := "*"
	if hostText != "*" {
		h, err := hostName(hostText, "the grant's host")
		if err != nil {
			return api.EgressGrantInput{}, err
		}
		host = h
	}
	var methods []string
	for _, m := range methodTexts {
		upper := strings.ToUpper(strings.TrimSpace(m))
		if !methodWord.MatchString(upper) {
			return api.EgressGrantInput{}, cli.Usage(`--method takes an HTTP method, such as GET, not "` + m + `"`)
		}
		methods = append(methods, upper)
	}
	for _, p := range pathTexts {
		if !strings.HasPrefix(p, "/") {
			return api.EgressGrantInput{}, cli.Usage(`--path takes a path starting with /, not "` + p + `"`)
		}
	}
	return api.EgressGrantInput{Action: api.EgressGrantInputAction(action), Host: host, Methods: unique(methods), Paths: unique(pathTexts)}, nil
}

// grantText is a grant as the egress log's rule names it, such as `deny DELETE api.github.com /repos/*`.
func grantText(action, host string, methods, paths []string) string {
	parts := []string{action}
	if len(methods) > 0 {
		parts = append(parts, strings.Join(methods, ","))
	}
	parts = append(parts, host)
	parts = append(parts, paths...)
	return strings.Join(parts, " ")
}

func grantInputText(g api.EgressGrantInput) string {
	return grantText(string(g.Action), g.Host, g.Methods, g.Paths)
}

func grantRule(g api.EgressGrant) string {
	return grantText(string(g.Action), g.Host, g.Methods, g.Paths)
}

// grantInput is a grant as read, to send back as it is.
func grantInput(g api.EgressGrant) api.EgressGrantInput {
	id := g.ID
	return api.EgressGrantInput{ID: &id, Action: api.EgressGrantInputAction(g.Action), Host: g.Host, Methods: g.Methods, Paths: g.Paths}
}

func grantInputs(grants []api.EgressGrant) []api.EgressGrantInput {
	out := make([]api.EgressGrantInput, len(grants))
	for i, g := range grants {
		out[i] = grantInput(g)
	}
	return out
}

func indentLines(text string) string {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		lines[i] = "  " + l
	}
	return strings.Join(lines, "\n")
}

func envSection(c *cli.Context, title string, header []string, rows [][]string) string {
	if len(rows) == 0 {
		return title + ": none"
	}
	return title + ":\n" + indentLines(cli.Table(c.Style, header, rows))
}

// shownValue is a plain variable's value on one line.
func shownValue(value *string) string {
	if value == nil {
		return ""
	}
	if strings.ContainsAny(*value, "\n\r") {
		return string(marshalKey(*value))
	}
	return *value
}

// octal is a file's mode as octal, such as 0600.
func octal(mode int64) string { return fmt.Sprintf("%04o", mode) }

// describeEnvironment is kantel env show: the environment, its variables (a protected one's bindings, never its
// value), files, repos and grants.
func describeEnvironment(c *cli.Context, e api.Environment) string {
	var variables, files, repos, grants [][]string
	for _, v := range e.Variables {
		if v.Protected {
			variables = append(variables, []string{v.Name, "protected", bindingsText(v.Bindings)})
		} else {
			variables = append(variables, []string{v.Name, shownValue(v.Value), ""})
		}
	}
	for _, f := range e.Files {
		files = append(files, []string{f.Path, octal(f.Mode), cli.Bytes(float64(f.SizeBytes)), cli.Ago(f.UpdatedAt, now(c))})
	}
	for _, r := range e.Repos {
		repos = append(repos, []string{r.URL, Deref(r.Path), Deref(r.Ref)})
	}
	for _, g := range e.Grants {
		grants = append(grants, []string{g.ID, grantRule(g)})
	}
	return strings.Join([]string{
		cli.Fields(c.Style, []cli.Field{
			{"id", e.ID},
			{"name", e.Name},
			{"description", Deref(e.Description)},
			{"sandboxes", fmt.Sprint(e.SandboxCount)},
			{"updated", cli.Timestamp(e.UpdatedAt) + " (" + cli.Ago(e.UpdatedAt, now(c)) + ")"},
		}),
		"",
		envSection(c, "Variables", []string{"NAME", "VALUE", "SENT ONLY TO"}, variables),
		envSection(c, "Files", []string{"PATH", "MODE", "SIZE", "UPDATED"}, files),
		envSection(c, "Repos", []string{"URL", "PATH", "REF"}, repos),
		envSection(c, "Grants", []string{"ID", "RULE"}, grants),
	}, "\n")
}

// environmentTable is kantel env list.
func environmentTable(c *cli.Context, environments []api.Environment) string {
	var rows [][]string
	for _, e := range environments {
		rows = append(rows, []string{e.ID, e.Name, fmt.Sprint(len(e.Variables)), fmt.Sprint(len(e.Files)),
			fmt.Sprint(len(e.Repos)), fmt.Sprint(len(e.Grants)), fmt.Sprint(e.SandboxCount), cli.Ago(e.UpdatedAt, now(c))})
	}
	return cli.Table(c.Style, []string{"ID", "NAME", "VARIABLES", "FILES", "REPOS", "GRANTS", "SANDBOXES", "UPDATED"}, rows)
}

// destination is where a request went: its host, a port other than 443 or 80, and its path (never the query).
func destination(e api.EgressEntry) string {
	port := ""
	if e.Port != 443 && e.Port != 80 {
		port = fmt.Sprintf(":%d", e.Port)
	}
	return e.Host + port + Deref(e.Path)
}

// describeEgress is kantel egress: what the sandbox has, then its log as a table, newest first as Kantel answers it.
func describeEgress(c *cli.Context, egress api.SandboxEgress, entries []api.EgressEntry, deniedOnly bool) string {
	// Its environments in order; from an older Kantel, the one it was made from.
	var ids []string
	names := map[string]string{}
	for _, e := range egress.Environments {
		ids = append(ids, e.ID)
		names[e.ID] = e.Name
	}
	if len(ids) == 0 && egress.Environment != nil {
		ids = []string{egress.Environment.ID}
		names[egress.Environment.ID] = egress.Environment.Name
	}
	var protected, grants []string
	for _, v := range egress.ProtectedVariables {
		from := ""
		// With more than one environment, which of them the value comes from.
		if v.EnvironmentID != nil && len(ids) > 1 {
			from = " from " + environmentsText([]string{*v.EnvironmentID}, names)
		}
		protected = append(protected, fmt.Sprintf("%s (%s…) to %s%s", v.Name, v.PlaceholderPrefix, bindingsText(v.Bindings), from))
	}
	for _, g := range egress.EnvironmentGrants {
		grants = append(grants, fmt.Sprintf("%s (environment, %s)", grantRule(g), g.ID))
	}
	for _, g := range egress.Grants {
		grants = append(grants, fmt.Sprintf("%s (sandbox, %s)", grantRule(g), g.ID))
	}
	head := cli.Fields(c.Style, []cli.Field{
		{"sandbox", egress.SandboxID + " (" + egress.SandboxName + ")"},
		{"environments", environmentsText(ids, names)},
		{"protected", strings.Join(protected, "; ")},
		{"grants", strings.Join(grants, "; ")},
	})
	if len(entries) == 0 {
		if deniedOnly {
			return head + "\n\nNo refused requests."
		}
		return head + "\n\nNo requests yet."
	}
	var rows [][]string
	for _, e := range entries {
		decision := string(e.Decision)
		if e.Status != nil {
			decision += fmt.Sprintf(" %d", *e.Status)
		}
		var why []string
		if e.Code != nil && *e.Code != "" {
			why = append(why, *e.Code)
		}
		rule := e.Rule
		if rule == nil {
			rule = e.Reason
		}
		if rule != nil && *rule != "" {
			why = append(why, *rule)
		}
		at := cliTime(e.At)
		rows = append(rows, []string{at, e.Method, destination(e), decision, strings.Join(why, ": "), strings.Join(e.Swapped, ",")})
	}
	return head + "\n\n" + cli.Table(c.Style, []string{"TIME", "METHOD", "DESTINATION", "DECISION", "CODE/RULE", "SWAPPED"}, rows)
}

// cliTime is a log entry's time, to the second: 2026-11-03 14:05:09.
func cliTime(at int64) string { return time.UnixMilli(at).UTC().Format("2006-01-02 15:04:05") }

// Finding an environment, and editing its lists.

// environmentIDOf is an environment's ID: ref itself when it is one (env_…), else the ID of the one with that name in
// the account.
func environmentIDOf(c *cli.Context, client *api.Client, ref string) (string, error) {
	if strings.HasPrefix(ref, "env_") {
		return ref, nil
	}
	account, err := AccountPtr(c)
	if err != nil {
		return "", err
	}
	list, err := client.ListEnvironments(c.Ctx, &api.ListEnvironmentsQuery{Account: account})
	if err != nil {
		return "", err
	}
	for _, e := range list.Items {
		if e.Name == ref {
			return e.ID, nil
		}
	}
	return "", cli.Fail(`there is no environment called "` + ref + `": kantel env list shows them`)
}

func loadEnvironment(c *cli.Context, client *api.Client, ref string, raw *json.RawMessage) (*api.Environment, error) {
	id, err := environmentIDOf(c, client, ref)
	if err != nil {
		return nil, err
	}
	var opts []api.CallOption
	if raw != nil {
		opts = append(opts, api.Raw(raw))
	}
	return client.GetEnvironment(c.Ctx, id, opts...)
}

// readStdin is everything on stdin.
func readStdin(c *cli.Context) ([]byte, error) {
	if c.IO.Stdin == nil {
		return nil, nil
	}
	return io.ReadAll(c.IO.Stdin)
}

// valueFromStdin is a value from stdin, less one final newline, for env set --value-stdin. It is never printed.
func valueFromStdin(c *cli.Context) (string, error) {
	if c.IO.StdinTTY {
		c.Note("kantel: reading the value from stdin; end it with Ctrl-D")
	}
	data, err := readStdin(c)
	if err != nil {
		return "", err
	}
	value := strings.TrimSuffix(string(data), "\n")
	if len(value) < len(data) {
		value = strings.TrimSuffix(value, "\r")
	}
	if value == "" {
		return "", cli.Usage("there was no value on stdin")
	}
	return value, nil
}

var modePattern = regexp.MustCompile(`^0?[0-7]{3}$`)

// modeOf is --mode 0600: a file mode in octal.
func modeOf(c *cli.Context) (*int64, error) {
	value, ok := c.Str("mode")
	if !ok {
		return nil, nil
	}
	if !modePattern.MatchString(value) {
		return nil, cli.Usage(`--mode takes an octal mode such as 0600, not "` + value + `"`)
	}
	var mode int64
	_, _ = fmt.Sscanf(value, "%o", &mode)
	return &mode, nil
}

// grantFlags are the flags env grant and grant share.
var grantFlags = []cli.Flag{
	{Name: "method", Type: cli.String, Multiple: true, Value: "<METHOD>", Description: "Only requests with this method, such as DELETE; repeat it"},
	{Name: "path", Type: cli.String, Multiple: true, Value: "<pattern>", Description: "Only these paths: * is one segment, ** the rest; repeat it"},
}

const grantDetails = "Grants apply on top of the account's proxy settings: the environment's, then the sandbox's own, and deny wins.\n" +
	"A grant with --method or --path has the egress proxy open that host's HTTPS to read each request.\n" +
	"Quote a pattern so your shell leaves its * alone:"

// addedGrantID is where a new grant went: ` (id)` of the grant in after whose ID wasn't in before.
func addedGrantID(before, after []api.EgressGrant) string {
	known := map[string]bool{}
	for _, g := range before {
		known[g.ID] = true
	}
	for _, g := range after {
		if !known[g.ID] {
			return " (" + g.ID + ")"
		}
	}
	return ""
}

// withoutGrant is the other grants: all but id, or a failure when there is none with that ID.
func withoutGrant(grants []api.EgressGrant, id, where string) ([]api.EgressGrantInput, error) {
	kept := []api.EgressGrantInput{}
	for _, g := range grants {
		if g.ID != id {
			kept = append(kept, grantInput(g))
		}
	}
	if len(kept) == len(grants) {
		return nil, cli.Fail(where + " has no grant " + id)
	}
	return kept, nil
}

// editAttempts is how many times an edit of a list is read and written again when the list changed in between.
const editAttempts = 3

// editAsRead runs edit, which reads a list, changes it and writes it with `expected` the list as read: Kantel refuses
// the write with conflict when the list changed in between, and the edit is made again on what is there now, so no
// one else's change is lost.
func editAsRead[T any](edit func() (T, error)) (T, error) {
	for attempt := 1; ; attempt++ {
		result, err := edit()
		var apiErr *api.Error
		if err == nil || attempt >= editAttempts || !errors.As(err, &apiErr) || apiErr.Code != "conflict" {
			return result, err
		}
	}
}

// The list writes, with `expected` always sent: an empty list as read is [], which the generated bodies would leave
// out (and so replace the list whatever it holds).

type grantsBody struct {
	Grants   []api.EgressGrantInput `json:"grants"`
	Expected []api.EgressGrantInput `json:"expected"`
}

type reposBody struct {
	Repos    []api.EnvironmentRepo `json:"repos"`
	Expected []api.EnvironmentRepo `json:"expected"`
}

func putGrants(c *cli.Context, client *api.Client, path string, grants, expected []api.EgressGrantInput, out any, raw *json.RawMessage) error {
	if grants == nil {
		grants = []api.EgressGrantInput{}
	}
	if expected == nil {
		expected = []api.EgressGrantInput{}
	}
	return client.Do(c.Ctx, api.Call{Method: "PUT", Path: path, Body: grantsBody{grants, expected}, Out: out}, api.Raw(raw))
}

func putRepos(c *cli.Context, client *api.Client, id string, repos, expected []api.EnvironmentRepo, raw *json.RawMessage) (*api.Environment, error) {
	if repos == nil {
		repos = []api.EnvironmentRepo{}
	}
	if expected == nil {
		expected = []api.EnvironmentRepo{}
	}
	var out api.Environment
	err := client.Do(c.Ctx, api.Call{Method: "PUT", Path: "/environments/" + url.PathEscape(id) + "/repos",
		Body: reposBody{repos, expected}, Out: &out}, api.Raw(raw))
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// writtenVariable is a variable as Kantel answered it, when the answer is an environment holding it.
type writtenVariable struct {
	Protected bool
	Bindings  []api.DestinationBinding
}

func variableIn(raw json.RawMessage, name string) *writtenVariable {
	var answer struct {
		Variables []struct {
			Name      string                    `json:"name"`
			Protected *bool                     `json:"protected"`
			Bindings  *[]api.DestinationBinding `json:"bindings"`
		} `json:"variables"`
	}
	if json.Unmarshal(raw, &answer) != nil {
		return nil
	}
	for _, v := range answer.Variables {
		if v.Name == name && v.Protected != nil && v.Bindings != nil {
			return &writtenVariable{*v.Protected, *v.Bindings}
		}
	}
	return nil
}

type savedFile struct{ Mode, SizeBytes int64 }

// fileIn is a secret file as Kantel answered it, when the answer is an environment holding it at p. Kantel answers
// the path as it keeps it, absolute under /home/user (~/ is there too); the command has it as typed.
func fileIn(raw json.RawMessage, p string) *savedFile {
	var answer struct {
		Files []struct {
			Path      string `json:"path"`
			Mode      *int64 `json:"mode"`
			SizeBytes *int64 `json:"sizeBytes"`
		} `json:"files"`
	}
	if json.Unmarshal(raw, &answer) != nil {
		return nil
	}
	rel := strings.TrimPrefix(p, "~/")
	resolved := path.Clean(rel)
	if !strings.HasPrefix(rel, "/") {
		resolved = path.Join("/home/user", rel)
	}
	for _, f := range answer.Files {
		if (f.Path == p || f.Path == resolved) && f.Mode != nil && f.SizeBytes != nil {
			return &savedFile{*f.Mode, *f.SizeBytes}
		}
	}
	return nil
}

// NoProtectedValues is what the CLI says, before it changes anything, on a deployment that keeps no protected values.
const NoProtectedValues = "this deployment doesn't support protected variables or secret files; plain variables, repos and grants still work"

// protectedValuesOffered is whether the deployment keeps protected variables and secret files, as GET /v1/whoami says:
// false only when it says so. An older deployment that doesn't say, or a failed read, is nil, and the write is tried.
func protectedValuesOffered(c *cli.Context, client *api.Client) *bool {
	caller, err := client.GetCaller(c.Ctx)
	if err != nil {
		return nil
	}
	return caller.ProtectedValues
}

// requireProtectedValues refuses, before anything is written, a protected value the deployment would refuse.
func requireProtectedValues(c *cli.Context, client *api.Client) error {
	if offered := protectedValuesOffered(c, client); offered != nil && !*offered {
		return cli.Fail(NoProtectedValues)
	}
	return nil
}

type deletedFrom struct {
	Deleted       string `json:"deleted"`
	EnvironmentID string `json:"environmentId"`
}

// environments is the "Environments and egress" section.
func environments() cli.Section {
	envArg := cli.Arg{Name: "env"}
	return cli.Section{Title: "Environments and egress", Commands: []*cli.Command{
		{
			Name: "env list", Summary: "The account's environments, or a sandbox's in order",
			Flags: []cli.Flag{{Name: "sandbox", Type: cli.String, Value: "<sandbox>",
				Description: "A sandbox's environments instead, in order: what each loses to a later one, and what is pending"}},
			Details: sandboxEnvironmentsDetails,
			Examples: []cli.Example{
				{What: "The account's environments", Line: "kantel env list"},
				{What: "A sandbox's, in order", Line: "kantel env ls --sandbox sbx_4kq9x2mt"},
			},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				if id, ok := c.Str("sandbox"); ok {
					var raw json.RawMessage
					list, err := client.ListSandboxEnvironments(c.Ctx, id, api.Raw(&raw))
					if err != nil {
						return err
					}
					c.Emit(raw, list, func() string { return sandboxEnvironmentTable(c, *list) })
					return nil
				}
				account, err := AccountPtr(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				list, err := client.ListEnvironments(c.Ctx, &api.ListEnvironmentsQuery{Account: account}, api.Raw(&raw))
				if err != nil {
					return err
				}
				emitWithoutProtectedValues(c, raw, list, func() string {
					if len(list.Items) == 0 {
						return "No environments. Make one: kantel env create <name>"
					}
					return environmentTable(c, list.Items)
				})
				return nil
			},
		},
		{
			Name: "env create", Summary: "Make an environment: variables, secret files, repos and grants for new sandboxes",
			Args:    []cli.Arg{{Name: "name"}},
			Flags:   []cli.Flag{{Name: "description", Type: cli.String, Value: "<text>", Description: "What it is for"}},
			Details: "A name is lower-case letters, digits and hyphens, unique in the account.",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := AccountPtr(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				environment, err := client.CreateEnvironment(c.Ctx, api.CreateEnvironmentBody{
					Account: account, Name: c.Arg(0), Description: StrPtr(c, "description"),
				}, api.Raw(&raw))
				if err != nil {
					return err
				}
				// Asked too, so whoever makes one for a protected value hears before setting it that it can't be.
				offered := protectedValuesOffered(c, client)
				emitWithoutProtectedValues(c, raw, environment, func() string {
					lines := []string{
						fmt.Sprintf("Created %s (%s).", environment.ID, environment.Name),
						"  Add a variable:  kantel env set " + environment.Name + " NAME=value",
						"  Use it:          kantel new --env " + environment.Name,
						"  Attach it:       kantel env attach <sandbox> " + environment.Name,
					}
					if offered != nil && !*offered {
						lines = append(lines, "Note: "+NoProtectedValues+".")
					}
					return strings.Join(lines, "\n")
				})
				return nil
			},
		},
		{
			Name: "env show", Summary: "Show an environment: its variables (never a protected one's value), files, repos and grants",
			Args: []cli.Arg{envArg},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				environment, err := loadEnvironment(c, client, c.Arg(0), &raw)
				if err != nil {
					return err
				}
				emitWithoutProtectedValues(c, raw, environment, func() string { return describeEnvironment(c, *environment) })
				return nil
			},
		},
		{
			Name: "env delete", Summary: "Delete an environment, with its sealed values and files",
			Args: []cli.Arg{envArg},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				id, err := environmentIDOf(c, client, c.Arg(0))
				if err != nil {
					return err
				}
				if err := client.DeleteEnvironment(c.Ctx, id); err != nil {
					return err
				}
				c.Emit(nil, map[string]string{"deleted": id}, func() string { return "Deleted " + id + "." })
				return nil
			},
		},
		envAttachCommand(),
		envDetachCommand(),
		envSetCommand(),
		{
			Name: "env unset", Summary: "Remove a variable from an environment",
			Args: []cli.Arg{envArg, {Name: "NAME"}},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				id, err := environmentIDOf(c, client, c.Arg(0))
				if err != nil {
					return err
				}
				name := c.Arg(1)
				if _, err := client.DeleteEnvironmentVariable(c.Ctx, id, name); err != nil {
					return err
				}
				c.Emit(nil, deletedFrom{name, id}, func() string { return "Removed " + name + " from " + c.Arg(0) + "." })
				return nil
			},
		},
		envFileCommand(),
		{
			Name: "env file rm", Summary: "Remove a secret file from an environment",
			Args: []cli.Arg{envArg, {Name: "path"}},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				id, err := environmentIDOf(c, client, c.Arg(0))
				if err != nil {
					return err
				}
				p := c.Arg(1)
				if _, err := client.DeleteEnvironmentFile(c.Ctx, id, &api.DeleteEnvironmentFileQuery{Path: &p}); err != nil {
					return err
				}
				c.Emit(nil, deletedFrom{p, id}, func() string { return "Removed " + p + " from " + c.Arg(0) + "." })
				return nil
			},
		},
		{
			Name: "env repo add", Summary: "Clone a git repository into each new sandbox once it runs",
			Args: []cli.Arg{envArg, {Name: "url"}},
			Flags: []cli.Flag{
				{Name: "path", Type: cli.String, Value: "<dir>", Description: "Where in the sandbox to clone it"},
				{Name: "ref", Type: cli.String, Value: "<ref>", Description: "The branch or tag (default the repository's default)"},
			},
			Details: "The URL is https://. It is cloned through the egress proxy, after the secret files are written, and a\n" +
				"failed clone is an event on the sandbox, not an error. Adding a URL again replaces its --path and --ref.",
			Run: func(c *cli.Context) error {
				u := c.Arg(1)
				if !strings.HasPrefix(u, "https://") {
					return cli.Usage("a repository's URL starts with https://")
				}
				repo := api.EnvironmentRepo{URL: u, Path: StrPtr(c, "path"), Ref: StrPtr(c, "ref")}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				var environment *api.Environment
				updated, err := editAsRead(func() (*api.Environment, error) {
					var err error
					if environment, err = loadEnvironment(c, client, c.Arg(0), nil); err != nil {
						return nil, err
					}
					var repos []api.EnvironmentRepo
					for _, r := range environment.Repos {
						if r.URL != u {
							repos = append(repos, r)
						}
					}
					return putRepos(c, client, environment.ID, append(repos, repo), environment.Repos, &raw)
				})
				if err != nil {
					return err
				}
				emitWithoutProtectedValues(c, raw, updated, func() string { return "Added " + u + " to " + environment.Name + "." })
				return nil
			},
		},
		{
			Name: "env repo rm", Summary: "Stop cloning a repository into new sandboxes",
			Args: []cli.Arg{envArg, {Name: "url"}},
			Run: func(c *cli.Context) error {
				u := c.Arg(1)
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				var environment *api.Environment
				updated, err := editAsRead(func() (*api.Environment, error) {
					var err error
					if environment, err = loadEnvironment(c, client, c.Arg(0), nil); err != nil {
						return nil, err
					}
					repos := []api.EnvironmentRepo{}
					for _, r := range environment.Repos {
						if r.URL != u {
							repos = append(repos, r)
						}
					}
					if len(repos) == len(environment.Repos) {
						return nil, cli.Fail(u + " isn't one of " + environment.Name + "'s repositories")
					}
					return putRepos(c, client, environment.ID, repos, environment.Repos, &raw)
				})
				if err != nil {
					return err
				}
				emitWithoutProtectedValues(c, raw, updated, func() string { return "Removed " + u + " from " + environment.Name + "." })
				return nil
			},
		},
		{
			Name: "env grant", Summary: "Allow or refuse requests to a host, by method and path, for every sandbox made from it",
			Args:    []cli.Arg{envArg, {Name: "allow|deny"}, {Name: "host"}},
			Flags:   grantFlags,
			Details: grantDetails + "\n  kantel env grant work deny api.github.com --method DELETE --path '/repos/**'",
			Run: func(c *cli.Context) error {
				grant, err := parseGrant(c.Arg(1), c.Arg(2), c.List("method"), c.List("path"))
				if err != nil {
					return err
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				var environment *api.Environment
				updated, err := editAsRead(func() (*api.Environment, error) {
					var err error
					if environment, err = loadEnvironment(c, client, c.Arg(0), nil); err != nil {
						return nil, err
					}
					expected := grantInputs(environment.Grants)
					var out api.Environment
					err = putGrants(c, client, "/environments/"+url.PathEscape(environment.ID)+"/grants",
						append(append([]api.EgressGrantInput{}, expected...), grant), expected, &out, &raw)
					return &out, err
				})
				if err != nil {
					return err
				}
				id := addedGrantID(environment.Grants, updated.Grants)
				emitWithoutProtectedValues(c, raw, updated, func() string {
					return fmt.Sprintf(`Added "%s"%s to %s.`, grantInputText(grant), id, environment.Name)
				})
				return nil
			},
		},
		{
			Name: "env grant rm", Summary: "Remove one of an environment's grants",
			Args: []cli.Arg{envArg, {Name: "grant-id"}},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				var environment *api.Environment
				updated, err := editAsRead(func() (*api.Environment, error) {
					var err error
					if environment, err = loadEnvironment(c, client, c.Arg(0), nil); err != nil {
						return nil, err
					}
					grants, err := withoutGrant(environment.Grants, c.Arg(1), environment.Name)
					if err != nil {
						return nil, err
					}
					var out api.Environment
					err = putGrants(c, client, "/environments/"+url.PathEscape(environment.ID)+"/grants",
						grants, grantInputs(environment.Grants), &out, &raw)
					return &out, err
				})
				if err != nil {
					return err
				}
				emitWithoutProtectedValues(c, raw, updated, func() string { return "Removed " + c.Arg(1) + " from " + environment.Name + "." })
				return nil
			},
		},
		{
			Name: "egress", Summary: "A sandbox's outbound requests: allowed or refused, and which protected variables were swapped in",
			Args: []cli.Arg{{Name: "sandbox"}},
			Flags: []cli.Flag{
				{Name: "denied", Type: cli.Bool, Description: "Only the refused requests"},
				{Name: "limit", Type: cli.String, Value: "<n>", Description: "At most this many, newest first (Kantel keeps 1000)"},
			},
			Details: "CODE/RULE is the X-Kantel-Proxy-Error code the sandbox saw, and the grant or setting that decided.\n" +
				"Paths are kept without their query. An HTTPS tunnel the proxy doesn't open shows as one CONNECT, with no\n" +
				"status: an HTTP error inside it (a 503, say) is the site's. The proxy's own failures show as upstream-failed.",
			Run: func(c *cli.Context) error {
				limit, err := Whole(c, "limit", 1)
				if err != nil {
					return err
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var query *api.GetSandboxEgressQuery
				if limit != nil {
					query = &api.GetSandboxEgressQuery{Limit: limit}
				}
				var raw json.RawMessage
				egress, err := client.GetSandboxEgress(c.Ctx, c.Arg(0), query, api.Raw(&raw))
				if err != nil {
					return err
				}
				denied := c.Bool("denied")
				entries := egress.Entries
				if denied {
					entries = nil
					items, _ := arrayItems(memberOf(raw, "entries"))
					kept := []json.RawMessage{}
					for i, e := range egress.Entries {
						if e.Decision == api.EgressEntryDecisionDenied {
							entries = append(entries, e)
							if i < len(items) {
								kept = append(kept, items[i])
							}
						}
					}
					raw = withMember(raw, "entries", joinArray(kept))
				}
				emitWithoutProtectedValues(c, raw, egress, func() string { return describeEgress(c, *egress, entries, denied) })
				return nil
			},
		},
		{
			Name: "grant", Summary: "Allow or refuse one sandbox's requests to a host, by method and path",
			Args:  []cli.Arg{{Name: "sandbox"}, {Name: "allow|deny"}, {Name: "host"}},
			Flags: grantFlags,
			Details: grantDetails + "\n  kantel grant sbx_123 deny api.github.com --method DELETE --path '/repos/**'\n" +
				"A running sandbox picks it up within seconds. kantel egress <sandbox> shows its grants.",
			Run: func(c *cli.Context) error {
				grant, err := parseGrant(c.Arg(1), c.Arg(2), c.List("method"), c.List("path"))
				if err != nil {
					return err
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				var sandbox *api.Sandbox
				updated, err := editAsRead(func() (*grantsAnswer, error) {
					var err error
					if sandbox, err = client.GetSandbox(c.Ctx, c.Arg(0)); err != nil {
						return nil, err
					}
					expected := grantInputs(sandbox.Grants)
					var out grantsAnswer
					err = putGrants(c, client, "/sandboxes/"+url.PathEscape(sandbox.ID)+"/grants",
						append(append([]api.EgressGrantInput{}, expected...), grant), expected, &out, &raw)
					return &out, err
				})
				if err != nil {
					return err
				}
				id := addedGrantID(sandbox.Grants, updated.Grants)
				c.Emit(raw, updated, func() string {
					return fmt.Sprintf(`Added "%s"%s to %s.`, grantInputText(grant), id, sandbox.ID)
				})
				return nil
			},
		},
		{
			Name: "grant rm", Summary: "Remove one of a sandbox's own grants",
			Args: []cli.Arg{{Name: "sandbox"}, {Name: "grant-id"}},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				var sandbox *api.Sandbox
				updated, err := editAsRead(func() (*grantsAnswer, error) {
					var err error
					if sandbox, err = client.GetSandbox(c.Ctx, c.Arg(0)); err != nil {
						return nil, err
					}
					grants, err := withoutGrant(sandbox.Grants, c.Arg(1), sandbox.ID)
					if err != nil {
						return nil, err
					}
					var out grantsAnswer
					err = putGrants(c, client, "/sandboxes/"+url.PathEscape(sandbox.ID)+"/grants", grants, grantInputs(sandbox.Grants), &out, &raw)
					return &out, err
				})
				if err != nil {
					return err
				}
				c.Emit(raw, updated, func() string { return "Removed " + c.Arg(1) + " from " + sandbox.ID + "." })
				return nil
			},
		},
	}}
}

// grantsAnswer is what a sandbox's grants' write answers, as far as the command reads it.
type grantsAnswer struct {
	Grants []api.EgressGrant `json:"grants"`
}

func envSetCommand() *cli.Command {
	return &cli.Command{
		Name:    "env set",
		Usage:   "env set <env> <NAME>[=<value>]",
		Summary: "Set a variable: plain, or protected so sandboxes get a placeholder and never the value",
		Args:    []cli.Arg{{Name: "env", Optional: true}, {Name: "NAME=value", Optional: true}},
		Flags: []cli.Flag{
			{Name: "env", Type: cli.String, Value: "<env>", Description: "The environment, instead of the first argument"},
			{Name: "protected", Type: cli.Bool, Description: "Keep the value out of sandboxes: each gets a kph_… placeholder instead"},
			{Name: "bind", Type: cli.String, Multiple: true, Value: "<host>[/path][:METHOD,…]", Description: "Where a protected value may be sent; repeat it"},
			{Name: "value-stdin", Type: cli.Bool, Description: "Read the value from stdin, which keeps it out of your shell history"},
			{Name: "keep-value", Type: cli.Bool, Description: "Change a protected variable's --bind without entering its value again"},
			{Name: "plain", Type: cli.Bool, Description: "Make a protected variable plain: sandboxes then get its value"},
		},
		Details: "A protected variable's value never enters a sandbox. Each sandbox gets a kph_… placeholder in its place,\n" +
			"which the host's egress proxy swaps for the value only in requests to a --bind destination:\n" +
			"<host>[/path-prefix][:METHOD,…], such as api.github.com or api.openai.com/v1/:POST,GET.\n" +
			"\n" +
			"--value-stdin reads the value from stdin, which keeps it out of your shell history and the process list:\n" +
			"  printf %s \"$GH_TOKEN\" | kantel env set work GH_TOKEN --value-stdin --protected --bind api.github.com\n" +
			"\n" +
			"Setting a protected variable again with a new value rotates it: running sandboxes keep their placeholder\n" +
			"and send the new value from their next request. It stays protected unless you give --plain.\n" +
			"--keep-value with --bind changes where it may go without entering it again.",
		Examples: []cli.Example{
			{What: "A plain variable", Line: "kantel env set web NODE_ENV=production"},
			{What: "A protected one, sent only to its API and never into a sandbox",
				Line: `printf %s "$TOKEN" | kantel env set web GITHUB_TOKEN --protected --bind api.github.com --value-stdin`},
		},
		Run: runEnvSet,
	}
}

var variableName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func runEnvSet(c *cli.Context) error {
	flagEnv, hasFlagEnv := c.Str("env")
	expected := 2
	if hasFlagEnv {
		expected = 1
	}
	if len(c.Args) != expected {
		if hasFlagEnv {
			return cli.Usage("give the variable once: kantel env set --env <env> NAME=value")
		}
		return cli.Usage("give the environment and the variable: kantel env set <env> NAME=value")
	}
	ref := c.Arg(0)
	if hasFlagEnv {
		ref = flagEnv
	}
	assignment := c.Arg(expected - 1)
	name, inlineValue, hasInline := strings.Cut(assignment, "=")
	// Never put the assignment in a message: it may hold the value.
	if !variableName.MatchString(name) {
		return cli.Usage("a variable's name is letters, digits and _, such as GH_TOKEN, before any =")
	}
	fromStdin, keep, plain, asked := c.Bool("value-stdin"), c.Bool("keep-value"), c.Bool("plain"), c.Bool("protected")
	ways := 0
	for _, given := range []bool{hasInline, fromStdin, keep} {
		if given {
			ways++
		}
	}
	if ways == 0 {
		return cli.Usage(fmt.Sprintf("give %s a value: %s=<value>, --value-stdin, or --keep-value to re-bind a protected one", name, name))
	}
	if ways > 1 {
		return cli.Usage("give the value one way: NAME=value, --value-stdin or --keep-value")
	}
	if plain && (asked || keep) {
		return cli.Usage("--plain makes the variable plain: leave out --protected and --keep-value")
	}
	var parsed []api.DestinationBinding
	for _, text := range c.List("bind") {
		b, err := parseBinding(text)
		if err != nil {
			return err
		}
		parsed = append(parsed, b)
	}
	bindings := mergeBindings(parsed)
	if plain && len(bindings) > 0 {
		return cli.Usage("--bind is for a protected variable, not a --plain one")
	}
	if keep && len(bindings) == 0 {
		return cli.Usage("--keep-value changes where the value may go: give the new --bind")
	}
	var value *string
	if fromStdin {
		v, err := valueFromStdin(c)
		if err != nil {
			return err
		}
		value = &v
	} else if hasInline {
		value = &inlineValue
	}
	client, err := Client(c)
	if err != nil {
		return err
	}
	// Asked for a protected value: refused here, on a deployment that keeps none, before anything is written.
	if asked || keep || len(bindings) > 0 {
		if err := requireProtectedValues(c, client); err != nil {
			return err
		}
	}
	environment, err := loadEnvironment(c, client, ref, nil)
	if err != nil {
		return err
	}
	var existing *api.EnvironmentVariable
	for i := range environment.Variables {
		if environment.Variables[i].Name == name {
			existing = &environment.Variables[i]
			break
		}
	}
	wasProtected := existing != nil && existing.Protected
	if keep && !wasProtected {
		return cli.Fail(fmt.Sprintf("%s isn't protected in %s, so there is no value to keep", name, environment.Name))
	}
	// Its bindings are sent only when --bind gives them, so a rotation never undoes a change to them made since the
	// read above. Its mode is sent when a flag gives it, and for a rotation of one read as protected: that value is
	// meant to be sealed, so if the variable was removed or made plain meanwhile, Kantel refuses the write (a protected
	// variable needs a binding) rather than keeping the new value in the clear. Read as plain or new, a value alone
	// leaves the mode as Kantel has it: one protected meanwhile stays so.
	var mode *bool
	switch {
	case plain:
		mode = api.Ptr(false)
	case asked || keep || len(bindings) > 0 || wasProtected:
		mode = api.Ptr(true)
	}
	if mode != nil && *mode && len(bindings) == 0 && !wasProtected {
		return cli.Usage("a protected variable needs --bind <host>: where its value may be sent")
	}
	var raw json.RawMessage
	if _, err := client.SetEnvironmentVariable(c.Ctx, environment.ID, name, api.SetEnvironmentVariableBody{
		Protected: mode, Value: value, Bindings: bindings,
	}, api.Raw(&raw)); err != nil {
		return err
	}
	// What it is now, as Kantel answers; failing that, what was sent on what was read.
	written := variableIn(raw, name)
	isProtected := wasProtected
	switch {
	case written != nil:
		isProtected = written.Protected
	case mode != nil:
		isProtected = *mode
	}
	var sent []api.DestinationBinding
	switch {
	case written != nil:
		sent = written.Bindings
	case len(bindings) > 0:
		sent = bindings
	case wasProtected:
		sent = existing.Bindings
	}
	live := wasProtected && isProtected
	verb := "Set"
	if live && value != nil {
		verb = "Rotated"
	}
	where := ""
	if isProtected {
		where = ": protected, sent only to " + bindingsText(sent)
	}
	shown := struct {
		EnvironmentID string `json:"environmentId"`
		Name          string `json:"name"`
		Protected     bool   `json:"protected"`
	}{environment.ID, name, isProtected}
	emitWithoutProtectedValues(c, raw, shown, func() string {
		next := "Sandboxes made from now on get it."
		if live {
			next = "Running sandboxes use it from their next request, with the same placeholder."
		}
		return fmt.Sprintf("%s %s in %s%s.\n%s", verb, name, environment.Name, where, next)
	})
	return nil
}

func envFileCommand() *cli.Command {
	return &cli.Command{
		Name:    "env file",
		Summary: "Add or replace a secret file, written into each new sandbox once it runs",
		Args:    []cli.Arg{{Name: "env"}, {Name: "path"}},
		Flags: []cli.Flag{
			{Name: "mode", Type: cli.String, Value: "<octal>", Description: "Its mode in the sandbox (default 0600)"},
			{Name: "from", Type: cli.String, Value: "<file>", Description: "Read it from this local file; default stdin"},
		},
		Details: "<path> is where it goes in the sandbox. Its content is sealed at rest and never shown again: kantel env\n" +
			"show lists its path, mode and size. A secret file is in the sandbox, so anything there can read it.\n" +
			"  kantel env file work /home/user/.npmrc --from ~/.npmrc\n" +
			"kantel env file rm <env> <path> removes one.",
		Run: func(c *cli.Context) error {
			p := c.Arg(1)
			mode, err := modeOf(c)
			if err != nil {
				return err
			}
			from, hasFrom := c.Str("from")
			if !hasFrom && c.IO.StdinTTY {
				return cli.Usage("give the content with --from <file>, or pipe it in")
			}
			client, err := Client(c)
			if err != nil {
				return err
			}
			// Before the content is read: a deployment that keeps no secret files would refuse it anyway.
			if err := requireProtectedValues(c, client); err != nil {
				return err
			}
			var content []byte
			if hasFrom {
				if !filepath.IsAbs(from) {
					from = filepath.Join(c.IO.Cwd, from)
				}
				if content, err = os.ReadFile(from); err != nil {
					return err
				}
			} else if content, err = readStdin(c); err != nil {
				return err
			}
			id, err := environmentIDOf(c, client, c.Arg(0))
			if err != nil {
				return err
			}
			encoded := base64.StdEncoding.EncodeToString(content)
			var raw json.RawMessage
			if _, err := client.SetEnvironmentFile(c.Ctx, id, api.SetEnvironmentFileBody{
				Path: p, Mode: mode, Content: &encoded, Encoding: api.Ptr(api.FileEncodingBase64),
			}, api.Raw(&raw)); err != nil {
				return err
			}
			size := int64(len(content))
			// The mode it has now, as Kantel answers: new contents without --mode keep the file's.
			shownMode := int64(0o600)
			if mode != nil {
				shownMode = *mode
			}
			if saved := fileIn(raw, p); saved != nil {
				shownMode, size = saved.Mode, saved.SizeBytes
			}
			fallback := struct {
				EnvironmentID string `json:"environmentId"`
				Path          string `json:"path"`
				SizeBytes     int64  `json:"sizeBytes"`
			}{id, p, int64(len(content))}
			emitWithoutProtectedValues(c, raw, fallback, func() string {
				return fmt.Sprintf("Saved %s (%s, mode %s) in %s.\nSandboxes made from now on get it.",
					p, cli.Bytes(float64(size)), octal(shownMode), c.Arg(0))
			})
			return nil
		},
	}
}
