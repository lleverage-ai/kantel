package kantel

// Kantel's MCP server for coding agents, over stdio and without an MCP library: newline-delimited JSON-RPC 2.0, one
// message a line. It answers initialize, ping, tools/list and tools/call; notifications get no reply. A tool call that
// carries a _meta.progressToken gets notifications/progress every 15 s while it works, and notifications/cancelled
// stops its wait (not what it started in the sandbox) and its answer. An error Kantel answers comes back as a tool
// result with isError, so the agent can read it. Nothing but JSON-RPC goes to stdout; logs go to stderr.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
)

// protocolVersions are the protocol revisions this server speaks, newest first.
var protocolVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

// mcpInstructions is what initialize tells the agent about using the tools.
const mcpInstructions = "Kantel gives you sandboxes: machines of your own to run code in, away from the user's computer. Create one with " +
	"sandbox_create (an isolate starts in milliseconds and runs JavaScript; type microvm is a full Linux with root, " +
	"Docker, a desktop and a browser) and keep its id. Run commands in it with sandbox_exec, and move files with " +
	"file_write, file_read and file_list. port_expose gives a server in it a URL; snapshot_save keeps its state to " +
	"start new sandboxes from. Stop it with sandbox_stop when you are done: a stopped sandbox keeps its disk and costs " +
	"nothing to run, and sandbox_resume brings it back. If a command may take longer than your MCP client waits " +
	"for a call, run sandbox_exec with detached, then wait for it with command_get; it runs with no time limit unless you " +
	"give it a timeoutMs (a host whose kantel-host predates exec-control still ends it after about 2 minutes on a microVM). " +
	"If an isolate's command needs a microVM (its answer says so), upgrade it with sandbox_upgrade, which keeps its id, " +
	"files (in /home/user/workspace, with /workspace linked there), env and grants, and run the command again; create " +
	"an isolate with autoUpgrade to have that done for you."

const (
	// progressInterval is how often a tool call that waits tells the client it is still working.
	progressInterval = 15 * time.Second
	// maxWaitMs is the longest any one tool call waits: an exec's longest timeout, or command_get's longest waitMs.
	maxWaitMs = 600_000
)

const (
	rpcParseError     = -32700
	rpcInvalidRequest = -32600
	rpcMethodNotFound = -32601
	rpcInvalidParams  = -32602
	rpcInternalError  = -32603
)

// About 64 KiB of a command's stdout or stderr reaches the agent; the middle of a longer one is cut.
const (
	outputLimit = 64 * 1024
	outputHead  = 16 * 1024
)

// Schemas.

type property struct {
	name                 string
	Type                 string   `json:"type"`
	Description          string   `json:"description"`
	Enum                 []string `json:"enum,omitempty"`
	Minimum              *int64   `json:"minimum,omitempty"`
	Maximum              *int64   `json:"maximum,omitempty"`
	AdditionalProperties *struct {
		Type string `json:"type"`
	} `json:"additionalProperties,omitempty"`
}

// properties keep their order in tools/list.
type properties []property

func (ps properties) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, p := range ps {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(jsonText(p.name))
		b.WriteByte(':')
		b.WriteString(jsonText(p))
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func (ps properties) get(name string) *property {
	for i := range ps {
		if ps[i].name == name {
			return &ps[i]
		}
	}
	return nil
}

type inputSchema struct {
	Type                 string     `json:"type"`
	Properties           properties `json:"properties"`
	Required             []string   `json:"required,omitempty"`
	AdditionalProperties bool       `json:"additionalProperties"`
}

type toolAnnotations struct {
	Title           string `json:"title"`
	ReadOnlyHint    *bool  `json:"readOnlyHint,omitempty"`
	DestructiveHint *bool  `json:"destructiveHint,omitempty"`
	IdempotentHint  *bool  `json:"idempotentHint,omitempty"`
	OpenWorldHint   *bool  `json:"openWorldHint,omitempty"`
}

type textContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// toolResult is what tools/call answers.
type toolResult struct {
	Content           []textContent `json:"content"`
	StructuredContent any           `json:"structuredContent,omitempty"`
	IsError           bool          `json:"isError,omitempty"`
}

type toolArgs map[string]any

type toolContext struct {
	client  *api.Client
	account string
	// poll is the longest command_get waits between polls.
	poll time.Duration
}

type mcpTool struct {
	Name        string
	Description string
	Schema      inputSchema
	Annotations toolAnnotations
	call        func(ctx context.Context, t toolContext, args toolArgs) (toolResult, error)
}

// toolDefinition is a tool as tools/list describes it.
type toolDefinition struct {
	Name        string          `json:"name"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	InputSchema inputSchema     `json:"inputSchema"`
	Annotations toolAnnotations `json:"annotations"`
}

var (
	sandboxTypes = []string{"isolate", "microvm"}
	encodings    = []string{"utf8", "base64"}
)

func intp(n int64) *int64 { return &n }
func boolp(b bool) *bool  { return &b }

func str(name, description string) property {
	return property{name: name, Type: "string", Description: description}
}

func enum(name, description string, values []string) property {
	return property{name: name, Type: "string", Description: description, Enum: values}
}

func integer(name, description string, min, max *int64) property {
	return property{name: name, Type: "integer", Description: description, Minimum: min, Maximum: max}
}

func boolean(name, description string) property {
	return property{name: name, Type: "boolean", Description: description}
}

func stringsProp(name, description string) property {
	return property{name: name, Type: "object", Description: description,
		AdditionalProperties: &struct {
			Type string `json:"type"`
		}{Type: "string"}}
}

var (
	sandboxIDProp = str("sandboxId", "The sandbox's ID, such as sbx_4kq9x2mt.")
	commandIDProp = str("commandId", "The command's ID, such as cmd_9a8b7c.")
)

func schema(props properties, required ...string) inputSchema {
	return inputSchema{Type: "object", Properties: props, Required: required, AdditionalProperties: false}
}

// Reading validated arguments.

// argumentError is a tool's argument that isn't what it needs.
type argumentError struct{ message string }

func (e *argumentError) Error() string { return e.message }

func (a toolArgs) text(name string) (string, error) {
	v, ok := a[name].(string)
	if !ok {
		return "", &argumentError{name + " is required"}
	}
	return v, nil
}

func (a toolArgs) optText(name string) *string {
	if v, ok := a[name].(string); ok {
		return &v
	}
	return nil
}

func (a toolArgs) optInt(name string) *int64 {
	n, ok := a[name].(json.Number)
	if !ok {
		return nil
	}
	if i, err := n.Int64(); err == nil {
		return &i
	}
	f, err := n.Float64()
	if err != nil {
		return nil
	}
	i := int64(f)
	return &i
}

func (a toolArgs) optBool(name string) *bool {
	if v, ok := a[name].(bool); ok {
		return &v
	}
	return nil
}

func (a toolArgs) isTrue(name string) bool {
	v := a.optBool(name)
	return v != nil && *v
}

func (a toolArgs) optChoice(name string, allowed []string) *string {
	v, ok := a[name].(string)
	if !ok || !has(allowed, v) {
		return nil
	}
	return &v
}

func (a toolArgs) optStrings(name string) map[string]string {
	v, ok := a[name].(map[string]any)
	if !ok {
		return nil
	}
	record := map[string]string{}
	for k, item := range v {
		if s, ok := item.(string); ok {
			record[k] = s
		}
	}
	return record
}

func check(name string, p *property, value any) string {
	switch p.Type {
	case "string":
		s, ok := value.(string)
		if !ok {
			return name + " must be a string"
		}
		if p.Enum != nil && !has(p.Enum, s) {
			return name + " must be one of " + strings.Join(p.Enum, ", ")
		}
	case "integer":
		n, ok := value.(json.Number)
		if !ok {
			return name + " must be a whole number"
		}
		f, err := n.Float64()
		if err != nil || math.IsInf(f, 0) || f != math.Trunc(f) {
			return name + " must be a whole number"
		}
		if p.Minimum != nil && f < float64(*p.Minimum) {
			return fmt.Sprintf("%s must be at least %d", name, *p.Minimum)
		}
		if p.Maximum != nil && f > float64(*p.Maximum) {
			return fmt.Sprintf("%s must be at most %d", name, *p.Maximum)
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return name + " must be true or false"
		}
	case "object":
		record, ok := value.(map[string]any)
		if !ok {
			return name + " must be an object"
		}
		if p.AdditionalProperties != nil {
			keys := make([]string, 0, len(record))
			for k := range record {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if _, ok := record[k].(string); !ok {
					return name + "." + k + " must be a string"
				}
			}
		}
	}
	return ""
}

// validateArguments is why args don't fit s, or "" when they do.
func validateArguments(s inputSchema, args toolArgs) string {
	for _, name := range s.Required {
		if args[name] == nil {
			return name + " is required"
		}
	}
	names := make([]string, 0, len(args))
	for k := range args {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, name := range names {
		p := s.Properties.get(name)
		if p == nil {
			return "there is no argument " + name
		}
		if args[name] == nil {
			continue
		}
		if problem := check(name, p, args[name]); problem != "" {
			return problem
		}
	}
	return ""
}

// Results.

// compact is a JSON answer on one line, as it came.
func compact(raw json.RawMessage) string {
	var b bytes.Buffer
	if json.Compact(&b, raw) != nil {
		return string(raw)
	}
	return b.String()
}

// jsonResult is Kantel's answer as a tool's result: its JSON as text, after lead if there is one, and as structured
// content.
func jsonResult(raw json.RawMessage, lead string) toolResult {
	text := compact(raw)
	if lead != "" {
		text = lead + "\n" + text
	}
	return toolResult{Content: []textContent{{Type: "text", Text: text}}, StructuredContent: raw}
}

// valueResult is a value of the server's own as a tool's result.
func valueResult(value any, lead string) toolResult {
	return jsonResult(json.RawMessage(jsonText(value)), lead)
}

func errorResult(message string, structured any) toolResult {
	return toolResult{Content: []textContent{{Type: "text", Text: message}}, StructuredContent: structured, IsError: true}
}

// stateLine is a sandbox's state for a tool's answer: running, or for one in error, why, with what to do when its
// boot couldn't place it.
func stateLine(s api.Sandbox) string {
	if s.State != api.SandboxStateError {
		return string(s.State)
	}
	why, reason, hint := "", "", ""
	if s.PlacementReason != nil {
		why = " (" + string(*s.PlacementReason) + ")"
		if h, ok := placementHints[string(*s.PlacementReason)]; ok {
			hint = "\n" + h
		}
	}
	if s.Reason != nil {
		reason = ": " + *s.Reason
	}
	return "error" + why + reason + hint
}

// clipOutput is output, its middle cut to keep it near 64 KiB of characters, with a note saying so.
func clipOutput(output string) string {
	n := utf8.RuneCountInString(output)
	if n <= outputLimit {
		return output
	}
	runes := []rune(output)
	tail := outputLimit - outputHead
	cut := n - outputLimit
	return string(runes[:outputHead]) +
		fmt.Sprintf("\n[kantel: %d characters cut here; redirect the output to a file and read it with file_read for all of it]\n", cut) +
		string(runes[n-tail:])
}

// pickUp says how to pick up a command still running when the answer goes back.
func pickUp(c api.Command) string {
	return fmt.Sprintf("Wait for it and read its output with command_get (sandboxId %s, commandId %s, waitMs up to %d), "+
		"or end it with command_kill.", c.SandboxID, c.ID, maxWaitMs)
}

type commandStructured struct {
	CommandID    string                   `json:"commandId"`
	State        api.CommandState         `json:"state"`
	ExitCode     *int64                   `json:"exitCode"`
	Stdout       string                   `json:"stdout"`
	Stderr       string                   `json:"stderr"`
	Truncated    bool                     `json:"truncated"`
	DurationMs   *int64                   `json:"durationMs"`
	NeedsMicrovm *api.CommandNeedsMicrovm `json:"needsMicrovm,omitempty"`
	Terminated   *api.CommandTermination  `json:"terminated,omitempty"`
	RerunAs      *string                  `json:"rerunAs,omitempty"`
	RerunOf      *string                  `json:"rerunOf,omitempty"`
}

// commandResult is a command as a tool answers it: its state, exit code and output, cut to about 64 KiB each.
func commandResult(c api.Command) toolResult {
	stdout, stderr := clipOutput(c.Stdout), clipOutput(c.Stderr)
	var lines []string
	switch c.State {
	case api.CommandStateRunning:
		lines = append(lines, fmt.Sprintf("The command %s is still running. %s", c.ID, pickUp(c)))
	case "timed_out":
		lines = append(lines, fmt.Sprintf("The command timed out and was killed. Give it a longer timeoutMs, up to %d.", maxWaitMs))
	case "killed":
		if strings.Contains(c.Stderr, "may still be running") {
			lines = append(lines, "The command is marked killed, but its host couldn't stop it (its stderr says why): to be sure, end it "+
				"with sandbox_exec, such as pkill -f.")
		} else {
			lines = append(lines, "The command was killed, and the processes it started with it.")
		}
	default:
		code := "unknown"
		if c.ExitCode != nil {
			code = fmt.Sprint(*c.ExitCode)
		}
		lines = append(lines, "The command exited with code "+code+".")
	}
	if c.RerunOf != nil {
		lines = append(lines, fmt.Sprintf("Its isolate needed a microVM for it (%s said so): Kantel upgraded %s to a microVM, "+
			"its files in /home/user/workspace (/workspace links there), and this is the command run again there.", *c.RerunOf, c.SandboxID))
	}
	if c.RerunAs != nil {
		lines = append(lines, fmt.Sprintf("It needed a microVM: Kantel upgraded %s and runs it again there as %s. Read that one "+
			"with command_get (sandboxId %s, commandId %s).", c.SandboxID, *c.RerunAs, c.SandboxID, *c.RerunAs))
	} else if c.NeedsMicrovm != nil {
		lines = append(lines, fmt.Sprintf("It needs a microVM: %s Call sandbox_upgrade with sandboxId %s (it keeps the id, files, "+
			"env and grants), then run it again.", c.NeedsMicrovm.Reason, c.SandboxID))
	}
	if c.Terminated != nil {
		lines = append(lines, "The isolate stopped it for using too much "+string(*c.Terminated)+" time.")
	}
	if c.Truncated {
		lines = append(lines, "Kantel kept only its first 1 MiB of output.")
	}
	if c.State != api.CommandStateRunning || stdout != "" || stderr != "" {
		shown := stdout
		if shown == "" {
			shown = "(empty)"
		}
		lines = append(lines, "stdout:", shown)
		if stderr != "" {
			lines = append(lines, "stderr:", stderr)
		}
	}
	return toolResult{
		Content: []textContent{{Type: "text", Text: strings.Join(lines, "\n")}},
		StructuredContent: commandStructured{CommandID: c.ID, State: c.State, ExitCode: c.ExitCode, Stdout: stdout, Stderr: stderr,
			Truncated: c.Truncated || stdout != c.Stdout || stderr != c.Stderr, DurationMs: c.DurationMs,
			NeedsMicrovm: c.NeedsMicrovm, Terminated: c.Terminated, RerunAs: c.RerunAs, RerunOf: c.RerunOf},
	}
}

var errorHints = map[string]string{
	"unauthenticated": "Kantel needs an API key: set KANTEL_API_KEY in this MCP server's environment (make one with kantel key create " +
		"agent --preset agent).",
	"forbidden": "The API key lacks the scope this needs.",
	"conflict":  "If the sandbox is stopped or paused, resume it with sandbox_resume first.",
}

// idempotencyHints say what to do about a 409 over an Idempotency-Key, by its details.idempotencyKey. Each tool call
// sends a new key, so calling the tool again never meets the same key: these say whether that is safe.
var idempotencyHints = map[string]string{
	"in_progress": "The same call is still running: check its result (command_list for a command) before calling again.",
	"held": "The first call didn't finish, so it may have taken effect: check (command_list, sandbox_list) before calling the " +
		"tool again.",
	"withheld": "The call was done, but its secret isn't kept for a retry: look the record up instead.",
}

// placementHints say what to do about a sandbox that can't be placed, by its reason.
var placementHints = map[string]string{
	"no_host":                 "No host is connected to run it. Try again once one is, or tell the user.",
	"no_host_for_type":        "No host runs this type. Try the other type (isolate or microvm), or tell the user.",
	"no_host_with_labels":     "No host has those host labels. Ask for others, or none.",
	"no_host_offers_size":     "No host offers that size or resources. Ask for a smaller size or other resources.",
	"no_host_enforces_egress": "No host that could take it enforces egress grants. Tell the user to upgrade kantel-host.",
	"no_host_for_template":    "No host runs this template. Create the sandbox without it, or tell the user.",
	"insufficient_capacity":   "The hosts are full now. Try again in a minute, or ask for a smaller size.",
	"host_unavailable": "The host this sandbox is on, or was asked to go on, can't take it now. Try again later, or create a new " +
		"sandbox.",
	"account_limit": "The account runs as many sandboxes as it may. Stop or delete one first.",
}

// notRunningOf is a conflict's details when it says a sandbox isn't running: its stable code, ID, state and hint.
func notRunningOf(e *api.Error) map[string]any {
	if e.Code != "conflict" || e.Details == nil {
		return nil
	}
	code, _ := e.Details["code"].(string)
	if !strings.HasPrefix(code, "sandbox_") {
		return nil
	}
	for _, k := range []string{"sandboxId", "state", "hint"} {
		if _, ok := e.Details[k].(string); !ok {
			return nil
		}
	}
	return e.Details
}

type toolErrorBody struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Reason  string         `json:"reason,omitempty"`
	Details map[string]any `json:"details,omitempty"`
}

// kantelErrorResult is one of Kantel's errors as a tool's result, with a hint where it helps.
func kantelErrorResult(e *api.Error) toolResult {
	notRunning := notRunningOf(e)
	hint := ""
	if code, _ := notRunning["code"].(string); code == "sandbox_starting" {
		hint = "The sandbox is still starting: call the tool again in a moment."
	} else if held, ok := e.Details["idempotencyKey"].(string); ok {
		hint = idempotencyHints[held]
	} else if h, ok := placementHints[e.Reason]; ok && e.Reason != "" {
		hint = h
	} else {
		hint = errorHints[e.Code]
	}
	message := e.Code
	if e.Reason != "" {
		message += " (" + e.Reason + ")"
	}
	message += ": " + e.Message
	if hint != "" {
		message += "\n" + hint
	}
	return errorResult(message, map[string]toolErrorBody{"error": {Code: e.Code, Message: e.Message, Reason: e.Reason, Details: notRunning}})
}

// Tools.

func sandboxAnswer(raw json.RawMessage, s *api.Sandbox) toolResult {
	return jsonResult(raw, fmt.Sprintf("Sandbox %s is %s.", s.ID, stateLine(*s)))
}

func accountPtr(account string) *string {
	if account == "" {
		return nil
	}
	return &account
}

var mcpTools = []mcpTool{
	{
		Name: "sandbox_create",
		Description: "Create a sandbox and wait until it runs; answers it, with its id. An isolate (the default) starts in " +
			"milliseconds and runs a JavaScript shell, but no native binaries. A microvm is a full Linux with root, " +
			"Docker, a desktop, a browser and SSH. Stop it with sandbox_stop when you are done.",
		Schema: schema(properties{
			enum("type", "isolate (default) or microvm.", sandboxTypes),
			enum("size", "A microVM's size; default the deployment's.", Sizes),
			str("name", "Default: a generated name."),
			str("from", "Start from this snapshot: its ID, or a saved snapshot's name."),
			str("image", "A microVM's base image; default the deployment's."),
			integer("autoStopMinutes", "Stop by itself this many minutes after starting; default 60.", intp(1), nil),
			integer("idleStopMinutes", "Also stop by itself once it has gone this many minutes without use: no command, SSH, desktop, browser or "+
				"hosted-port traffic. Default: no idle stop.", intp(1), nil),
			stringsProp("labels", "Labels to find it by, such as { task: 'PROJ-12' }."),
			stringsProp("env", "Environment variables every command sees. Not for secrets: anyone who may exec sees them."),
			str("host", "Run it on this host, its name or ID. Only when the user asks for a host; default: Kantel picks."),
			boolean("autoUpgrade", "For an isolate: when a command needs a microVM, Kantel upgrades it (as sandbox_upgrade does) and "+
				"runs the command again there, once, answering that run. Use it when a task may turn out to need more than a shell."),
		}),
		Annotations: toolAnnotations{Title: "Create a sandbox", ReadOnlyHint: boolp(false), DestructiveHint: boolp(false), IdempotentHint: boolp(false)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			body := api.CreateSandboxBody{
				Account: accountPtr(t.account), Name: a.optText("name"), From: a.optText("from"), Image: a.optText("image"),
				Labels: a.optStrings("labels"), Env: a.optStrings("env"), Host: a.optText("host"), Wait: api.Ptr(true),
			}
			if v := a.optChoice("type", sandboxTypes); v != nil {
				body.Type = api.Ptr(api.SandboxType(*v))
			}
			if v := a.optChoice("size", Sizes); v != nil {
				body.Size = api.Ptr(api.SandboxSizeName(*v))
			}
			if n := a.optInt("autoStopMinutes"); n != nil {
				body.AutoStopMinutes = api.Of(*n)
			}
			if n := a.optInt("idleStopMinutes"); n != nil {
				body.IdleStopMinutes = api.Of(*n)
			}
			if a.isTrue("autoUpgrade") {
				body.AutoUpgrade = api.Ptr(true)
			}
			var raw json.RawMessage
			s, err := t.client.CreateSandbox(ctx, body, api.Raw(&raw))
			if err != nil {
				return toolResult{}, err
			}
			return jsonResult(raw, fmt.Sprintf("Sandbox %s (%s) is %s.", s.ID, s.Name, stateLine(*s))), nil
		},
	},
	{
		Name:        "sandbox_list",
		Description: "List the account's sandboxes, newest first: running ones, or all of them with all.",
		Schema: schema(properties{
			boolean("all", "Include stopped, paused and errored ones."),
			boolean("mine", "Only the key's person's own, not ones others share in an organisation."),
		}),
		Annotations: toolAnnotations{Title: "List sandboxes", ReadOnlyHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			var raw json.RawMessage
			_, err := t.client.ListSandboxes(ctx, &api.ListSandboxesQuery{Account: accountPtr(t.account), All: a.optBool("all"),
				Mine: a.optBool("mine")}, api.Raw(&raw))
			if err != nil {
				return toolResult{}, err
			}
			return jsonResult(raw, ""), nil
		},
	},
	{
		Name:        "sandbox_get",
		Description: "Get a sandbox: its state, type, what it can do, when it stops by itself and what it has cost.",
		Schema:      schema(properties{sandboxIDProp}, "sandboxId"),
		Annotations: toolAnnotations{Title: "Get a sandbox", ReadOnlyHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			var raw json.RawMessage
			s, err := t.client.GetSandbox(ctx, id, api.Raw(&raw))
			if err != nil {
				return toolResult{}, err
			}
			return sandboxAnswer(raw, s), nil
		},
	},
	{
		Name: "sandbox_stop",
		Description: "Stop a sandbox: its disk is kept as a snapshot and running programs end. It then costs nothing to run; " +
			"sandbox_resume brings it back. With pause, a microVM keeps its memory too. With wait, answers once it has " +
			"stopped and its snapshot is saved.",
		Schema: schema(properties{
			sandboxIDProp,
			boolean("pause", "Keep its memory as well (microVMs only)."),
			boolean("wait", "Answer once it is stopped or paused, not while it is stopping."),
		}, "sandboxId"),
		Annotations: toolAnnotations{Title: "Stop a sandbox", ReadOnlyHint: boolp(false), DestructiveHint: boolp(false), IdempotentHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			body := api.StopSandboxBody{}
			if a.isTrue("pause") {
				body.KeepMemory = api.Ptr(true)
			}
			if a.isTrue("wait") {
				body.Wait = api.Ptr(true)
			}
			var raw json.RawMessage
			s, err := t.client.StopSandbox(ctx, id, body, api.Raw(&raw))
			if err != nil {
				return toolResult{}, err
			}
			return sandboxAnswer(raw, s), nil
		},
	},
	{
		Name:        "sandbox_resume",
		Description: "Resume a stopped or paused sandbox and wait until it runs. Same id; files are as they were.",
		Schema:      schema(properties{sandboxIDProp}, "sandboxId"),
		Annotations: toolAnnotations{Title: "Resume a sandbox", ReadOnlyHint: boolp(false), DestructiveHint: boolp(false), IdempotentHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			var raw json.RawMessage
			s, err := t.client.ResumeSandbox(ctx, id, api.ResumeSandboxBody{Wait: api.Ptr(true)}, api.Raw(&raw))
			if err != nil {
				return toolResult{}, err
			}
			return sandboxAnswer(raw, s), nil
		},
	},
	{
		Name: "sandbox_upgrade",
		Description: "Turn an isolate into a microVM and wait until it runs: the same id, name, labels, env, environments, grants " +
			"and protected variables, and its /workspace files in /home/user/workspace, with /workspace a link there, so " +
			"its paths still work. Use it when an isolate's command needs a microVM (git, node, python, a package " +
			"manager, a build, Docker), then run the command again; a stopped isolate comes back running. A microVM " +
			"costs more than an isolate from then on. If the microVM can't be made, the isolate is left as it was.",
		Schema: schema(properties{
			sandboxIDProp,
			enum("size", "The microVM's size; default the deployment's.", Sizes),
			str("image", "The microVM's base image; default the deployment's."),
		}, "sandboxId"),
		Annotations: toolAnnotations{Title: "Upgrade an isolate to a microVM", ReadOnlyHint: boolp(false), DestructiveHint: boolp(false), IdempotentHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			body := api.UpgradeSandboxBody{Image: a.optText("image"), Wait: api.Ptr(true)}
			if v := a.optChoice("size", Sizes); v != nil {
				body.Size = api.Ptr(api.SandboxSizeName(*v))
			}
			var raw json.RawMessage
			s, err := t.client.UpgradeSandbox(ctx, id, body, api.Raw(&raw))
			if err != nil {
				return toolResult{}, err
			}
			return jsonResult(raw, fmt.Sprintf("Sandbox %s is a %s now, %s. Its files are in /home/user/workspace (/workspace links "+
				"there): run the command again.", s.ID, s.Type, stateLine(*s))), nil
		},
	},
	{
		Name:        "sandbox_fork",
		Description: "Make copies of a sandbox from its newest snapshot and wait until they run. The source is unchanged.",
		Schema: schema(properties{
			sandboxIDProp,
			integer("count", "How many copies; default 1.", intp(1), intp(50)),
			str("name", "The copies' name; default generated."),
		}, "sandboxId"),
		Annotations: toolAnnotations{Title: "Fork a sandbox", ReadOnlyHint: boolp(false), DestructiveHint: boolp(false), IdempotentHint: boolp(false)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			var raw json.RawMessage
			forked, err := t.client.ForkSandbox(ctx, id, api.ForkSandboxBody{Count: a.optInt("count"), Name: a.optText("name"),
				Wait: api.Ptr(true)}, api.Raw(&raw))
			if err != nil {
				return toolResult{}, err
			}
			ids := make([]string, len(forked.Items))
			for i, s := range forked.Items {
				ids[i] = s.ID
			}
			return jsonResult(raw, "Made "+strings.Join(ids, ", ")+"."), nil
		},
	},
	{
		Name: "sandbox_delete",
		Description: "Delete a sandbox for good, with its automatic snapshots; saved snapshots of it stay. It can't be undone: " +
			"to stop paying for a sandbox you may want again, use sandbox_stop.",
		Schema:      schema(properties{sandboxIDProp}, "sandboxId"),
		Annotations: toolAnnotations{Title: "Delete a sandbox", ReadOnlyHint: boolp(false), DestructiveHint: boolp(true), IdempotentHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			var raw json.RawMessage
			s, err := t.client.DeleteSandbox(ctx, id, api.Raw(&raw))
			if err != nil {
				return toolResult{}, err
			}
			return jsonResult(raw, fmt.Sprintf("Sandbox %s is being deleted.", s.ID)), nil
		},
	},
	{
		Name: "sandbox_exec",
		Description: "Run a shell command line in a running sandbox (bash -lc on a microVM) and wait for it to end; answers its " +
			"exit code, stdout and stderr, each cut to about 64 KiB. Default timeout 30 s, at most 10 minutes: past it the " +
			"command is killed. With detached it starts and answers its commandId at once, for when your MCP client " +
			"gives up on a call sooner than the command takes; then wait for it with command_get. A detached command has " +
			"no time limit unless you give it a timeoutMs; a host whose kantel-host predates exec-control still ends it after " +
			"about 2 minutes on a microVM, and an isolate runs a command for at most 30 s unless its timeoutMs says otherwise.",
		Schema: schema(properties{
			sandboxIDProp,
			str("command", "A shell command line, such as 'npm test 2>&1 | tail -50'."),
			str("cwd", "The directory to run it in; default the sandbox user's home."),
			integer("timeoutMs", "Kill it after this many milliseconds; default 30000, and none for a detached command.", intp(1), intp(maxWaitMs)),
			boolean("detached", "Start it and answer its commandId at once; it runs until it ends, its timeoutMs, or command_kill."),
			stringsProp("env", "Environment variables for this command."),
		}, "sandboxId", "command"),
		Annotations: toolAnnotations{Title: "Run a command", ReadOnlyHint: boolp(false), DestructiveHint: boolp(false), OpenWorldHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			line, err := a.text("command")
			if err != nil {
				return toolResult{}, err
			}
			detached := a.isTrue("detached")
			body := api.RunCommandBody{Command: line, Cwd: a.optText("cwd"), TimeoutMs: a.optInt("timeoutMs"), Env: a.optStrings("env")}
			if detached {
				body.Detached = api.Ptr(true)
			}
			// RunCommand sends one Idempotency-Key per tool call, which its retries share: the command runs once.
			cmd, err := t.client.RunCommand(ctx, id, body)
			if err != nil {
				return toolResult{}, err
			}
			if !detached || cmd.State != api.CommandStateRunning {
				return commandResult(*cmd), nil
			}
			return valueResult(struct {
				CommandID string           `json:"commandId"`
				State     api.CommandState `json:"state"`
			}{cmd.ID, cmd.State}, fmt.Sprintf("Started %s. %s", cmd.ID, pickUp(*cmd))), nil
		},
	},
	{
		Name: "command_get",
		Description: "A command's state, exit code and output so far, each cut to about 64 KiB. With waitMs, waits up to that long " +
			"for it to end first; if it is still running then, call command_get again.",
		Schema: schema(properties{
			sandboxIDProp,
			commandIDProp,
			integer("waitMs", "Wait up to this many milliseconds for it to end; default 0, at most 600000.", intp(0), intp(maxWaitMs)),
		}, "sandboxId", "commandId"),
		Annotations: toolAnnotations{Title: "Get a command", ReadOnlyHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			sandbox, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			id, err := a.text("commandId")
			if err != nil {
				return toolResult{}, err
			}
			wait := int64(0)
			if n := a.optInt("waitMs"); n != nil {
				wait = *n
			}
			deadline := time.Now().Add(time.Duration(wait) * time.Millisecond)
			cmd, err := t.client.GetCommand(ctx, sandbox, id)
			if err != nil {
				return toolResult{}, err
			}
			pause := min(250*time.Millisecond, t.poll)
			for cmd.State == api.CommandStateRunning && time.Now().Before(deadline) {
				timer := time.NewTimer(max(0, min(pause, time.Until(deadline))))
				select {
				case <-ctx.Done():
					timer.Stop()
					return toolResult{}, ctx.Err()
				case <-timer.C:
				}
				pause = min(pause*2, t.poll)
				if cmd, err = t.client.GetCommand(ctx, sandbox, id); err != nil {
					return toolResult{}, err
				}
			}
			return commandResult(*cmd), nil
		},
	},
	{
		Name: "command_list",
		Description: "A sandbox's commands, newest first, with their state and exit code but not their output (command_get has " +
			"it). Finds a command whose call your MCP client gave up on. When there are more, nextCursor is set: pass it " +
			"as cursor for the next, older page.",
		Schema: schema(properties{
			sandboxIDProp,
			integer("limit", "At most this many; default 20.", intp(1), intp(100)),
			str("cursor", "A previous answer's nextCursor, for the page after it."),
		}, "sandboxId"),
		Annotations: toolAnnotations{Title: "List commands", ReadOnlyHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			limit := a.optInt("limit")
			if limit == nil {
				limit = intp(20)
			}
			page, err := t.client.ListCommands(ctx, id, &api.ListCommandsQuery{Limit: limit, Cursor: a.optText("cursor")})
			if err != nil {
				return toolResult{}, err
			}
			type item struct {
				CommandID  string           `json:"commandId"`
				Command    string           `json:"command"`
				State      api.CommandState `json:"state"`
				ExitCode   *int64           `json:"exitCode"`
				StartedAt  int64            `json:"startedAt"`
				DurationMs *int64           `json:"durationMs"`
			}
			items := make([]item, len(page.Items))
			for i, c := range page.Items {
				items[i] = item{c.ID, c.Command, c.State, c.ExitCode, c.StartedAt, c.DurationMs}
			}
			if page.NextCursor == nil {
				return valueResult(struct {
					Items []item `json:"items"`
				}{items}, ""), nil
			}
			return valueResult(struct {
				Items      []item `json:"items"`
				NextCursor string `json:"nextCursor"`
			}{items, *page.NextCursor}, fmt.Sprintf("There are older commands: call command_list again with cursor %s for them.", *page.NextCursor)), nil
		},
	},
	{
		Name: "command_kill",
		Description: "Kill a running command and the processes it started. One that has ended is answered as it is. On a host " +
			"whose kantel-host predates exec-control it is only marked killed and its stderr says so: end it with " +
			"sandbox_exec too, such as pkill -f.",
		Schema:      schema(properties{sandboxIDProp, commandIDProp}, "sandboxId", "commandId"),
		Annotations: toolAnnotations{Title: "Kill a command", ReadOnlyHint: boolp(false), DestructiveHint: boolp(false), IdempotentHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			sandbox, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			id, err := a.text("commandId")
			if err != nil {
				return toolResult{}, err
			}
			cmd, err := t.client.KillCommand(ctx, sandbox, id)
			if err != nil {
				return toolResult{}, err
			}
			return commandResult(*cmd), nil
		},
	},
	{
		Name:        "file_read",
		Description: "Read a file of up to 1 MiB from a sandbox, as UTF-8 text, or base64 for a binary file.",
		Schema: schema(properties{
			sandboxIDProp,
			str("path", "An absolute path, or one relative to the sandbox user's home."),
			enum("encoding", "utf8 (default) or base64.", encodings),
		}, "sandboxId", "path"),
		Annotations: toolAnnotations{Title: "Read a file", ReadOnlyHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			path, err := a.text("path")
			if err != nil {
				return toolResult{}, err
			}
			query := &api.ReadFileQuery{Path: &path}
			if v := a.optChoice("encoding", encodings); v != nil {
				query.Encoding = api.Ptr(api.FileEncoding(*v))
			}
			var raw json.RawMessage
			file, err := t.client.ReadFile(ctx, id, query, api.Raw(&raw))
			if err != nil {
				return toolResult{}, err
			}
			return toolResult{Content: []textContent{{Type: "text", Text: file.Content}}, StructuredContent: raw}, nil
		},
	},
	{
		Name:        "file_write",
		Description: "Write a file in a sandbox, making its directories and replacing what was there.",
		Schema: schema(properties{
			sandboxIDProp,
			str("path", "An absolute path, or one relative to the sandbox user's home."),
			str("content", "The file's content: text, or base64 with encoding base64."),
			enum("encoding", "utf8 (default) or base64.", encodings),
			str("mode", "Octal permissions, such as 0755."),
		}, "sandboxId", "path", "content"),
		Annotations: toolAnnotations{Title: "Write a file", ReadOnlyHint: boolp(false), DestructiveHint: boolp(true), IdempotentHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			path, err := a.text("path")
			if err != nil {
				return toolResult{}, err
			}
			content, err := a.text("content")
			if err != nil {
				return toolResult{}, err
			}
			body := api.WriteFileBody{Path: path, Content: content, Mode: a.optText("mode")}
			if v := a.optChoice("encoding", encodings); v != nil {
				body.Encoding = api.Ptr(api.FileEncoding(*v))
			}
			var raw json.RawMessage
			entry, err := t.client.WriteFile(ctx, id, body, api.Raw(&raw))
			if err != nil {
				return toolResult{}, err
			}
			return jsonResult(raw, fmt.Sprintf("Wrote %s (%d bytes).", entry.Path, entry.Size)), nil
		},
	},
	{
		Name:        "file_list",
		Description: "List a directory in a sandbox: each entry's name, kind and size.",
		Schema: schema(properties{
			sandboxIDProp,
			str("path", "The directory; default the sandbox user's home."),
		}, "sandboxId"),
		Annotations: toolAnnotations{Title: "List a directory", ReadOnlyHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			var raw json.RawMessage
			if _, err := t.client.ListFiles(ctx, id, &api.ListFilesQuery{Path: a.optText("path")}, api.Raw(&raw)); err != nil {
				return toolResult{}, err
			}
			return jsonResult(raw, ""), nil
		},
	},
	{
		Name: "port_expose",
		Description: "Give a port in a sandbox an HTTPS URL, for a web server running in it (listening on 0.0.0.0 or localhost). " +
			"Unless public, the URL carries a token: share it only with whoever should open it.",
		Schema: schema(properties{
			sandboxIDProp,
			integer("port", "The port the server listens on.", intp(1), intp(65_535)),
			boolean("public", "Anyone with the URL may open it, with no token. Default false."),
		}, "sandboxId", "port"),
		Annotations: toolAnnotations{Title: "Expose a port", ReadOnlyHint: boolp(false), DestructiveHint: boolp(false), IdempotentHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			port := int64(0)
			if n := a.optInt("port"); n != nil {
				port = *n
			}
			var raw json.RawMessage
			exposed, err := t.client.ExposePort(ctx, id, api.ExposePortBody{Port: port, Public: a.optBool("public")}, api.Raw(&raw))
			if err != nil {
				return toolResult{}, err
			}
			return jsonResult(raw, fmt.Sprintf("Port %d is at %s", exposed.Port, exposed.URL)), nil
		},
	},
	{
		Name: "snapshot_save",
		Description: "Save a sandbox's state now under a name, kept until deleted. New sandboxes start from it with " +
			"sandbox_create's from.",
		Schema: schema(properties{
			sandboxIDProp,
			str("name", "Unique in the account."),
			str("description", "What it holds."),
			boolean("replace", "Replace a saved snapshot of the same name."),
			boolean("memory", "Keep a running microVM's memory as well as its disk, so a sandbox made from it carries on where it was, "+
				"on the same size only. Default false: the disk alone, much smaller."),
		}, "sandboxId", "name"),
		Annotations: toolAnnotations{Title: "Save a snapshot", ReadOnlyHint: boolp(false), DestructiveHint: boolp(false), IdempotentHint: boolp(false)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			name, err := a.text("name")
			if err != nil {
				return toolResult{}, err
			}
			var raw json.RawMessage
			snap, err := t.client.SaveSnapshot(ctx, api.SaveSnapshotBody{SandboxID: id, Name: name, Description: a.optText("description"),
				Replace: a.optBool("replace"), Memory: a.optBool("memory")}, api.Raw(&raw))
			if err != nil {
				return toolResult{}, err
			}
			label := snap.ID
			if snap.Name != nil {
				label = *snap.Name
			}
			return jsonResult(raw, fmt.Sprintf("Saved %s (%s).", label, snap.ID)), nil
		},
	},
	{
		Name:        "snapshot_list",
		Description: "List snapshots, newest first: the account's saved ones, or one sandbox's history.",
		Schema: schema(properties{
			str("sandboxId", "Only this sandbox's snapshots."),
			boolean("saved", "Only saved snapshots."),
		}),
		Annotations: toolAnnotations{Title: "List snapshots", ReadOnlyHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			query := &api.ListSnapshotsQuery{Account: accountPtr(t.account), SandboxID: a.optText("sandboxId")}
			if a.isTrue("saved") {
				query.Kind = api.Ptr(api.SnapshotKind("saved"))
			}
			var raw json.RawMessage
			if _, err := t.client.ListSnapshots(ctx, query, api.Raw(&raw)); err != nil {
				return toolResult{}, err
			}
			return jsonResult(raw, ""), nil
		},
	},
	{
		Name: "browser_open",
		Description: "Start a microVM sandbox's Chromium; answers a URL a person can watch and drive it at, and a CDP URL for " +
			"Playwright's connectOverCDP or Puppeteer.",
		Schema:      schema(properties{sandboxIDProp, boolean("viewOnly", "Watch only: no keyboard or mouse.")}, "sandboxId"),
		Annotations: toolAnnotations{Title: "Open the browser", ReadOnlyHint: boolp(false), DestructiveHint: boolp(false), IdempotentHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			var raw json.RawMessage
			access, err := t.client.OpenBrowser(ctx, id, api.ViewAccessBody{ViewOnly: a.optBool("viewOnly")}, api.Raw(&raw))
			if err != nil {
				return toolResult{}, err
			}
			return jsonResult(raw, fmt.Sprintf("Live view: %s\nCDP: %s", access.URL, access.CDPURL)), nil
		},
	},
	{
		Name:        "desktop_open",
		Description: "A short-lived URL that shows a microVM sandbox's Linux desktop in a browser, to watch or drive.",
		Schema:      schema(properties{sandboxIDProp, boolean("viewOnly", "Watch only: no keyboard or mouse.")}, "sandboxId"),
		Annotations: toolAnnotations{Title: "Open the desktop", ReadOnlyHint: boolp(false), DestructiveHint: boolp(false), IdempotentHint: boolp(true)},
		call: func(ctx context.Context, t toolContext, a toolArgs) (toolResult, error) {
			id, err := a.text("sandboxId")
			if err != nil {
				return toolResult{}, err
			}
			var raw json.RawMessage
			access, err := t.client.OpenDesktop(ctx, id, api.ViewAccessBody{ViewOnly: a.optBool("viewOnly")}, api.Raw(&raw))
			if err != nil {
				return toolResult{}, err
			}
			return jsonResult(raw, "Desktop: "+access.URL), nil
		},
	},
}

// toolDefinitions are the tools as tools/list describes them.
func toolDefinitions() []toolDefinition {
	defs := make([]toolDefinition, len(mcpTools))
	for i, t := range mcpTools {
		defs[i] = toolDefinition{Name: t.Name, Title: t.Annotations.Title, Description: t.Description, InputSchema: t.Schema,
			Annotations: t.Annotations}
	}
	return defs
}

// The server.

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      any       `json:"id"`
	Result  any       `json:"result,omitempty"`
	Error   *rpcError `json:"error,omitempty"`
}

type rpcNotification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

func success(id, result any) any { return rpcResponse{JSONRPC: "2.0", ID: id, Result: result} }

func failure(id any, code int, message string) any {
	return rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: message}}
}

// idOf is a request's ID, a string or a number, or nil.
func idOf(v any) any {
	switch v.(type) {
	case string, json.Number:
		return v
	}
	return nil
}

// callKey is a request ID as a key: "1" and 1 are two requests.
func callKey(id any) (string, bool) {
	switch v := id.(type) {
	case string:
		return "s:" + v, true
	case json.Number:
		return "n:" + v.String(), true
	}
	return "", false
}

// mcpServer answers JSON-RPC messages for one Kantel client.
type mcpServer struct {
	client  *api.Client
	version string
	// account is the account new sandboxes and lists are in; "" for the caller's.
	account string
	log     func(string)
	// progressEvery is how often a call with a progress token reports progress; pollEvery the longest command_get waits
	// between polls.
	progressEvery, pollEvery time.Duration
	tools                    map[string]*mcpTool

	mu sync.Mutex
	// calls are the tool calls under way, by request ID, to cancel on notifications/cancelled.
	calls map[string]context.CancelFunc
}

func newMCPServer(client *api.Client, version, account string, log func(string)) *mcpServer {
	if log == nil {
		log = func(string) {}
	}
	s := &mcpServer{client: client, version: version, account: account, log: log, progressEvery: progressInterval,
		pollEvery: 2 * time.Second, tools: map[string]*mcpTool{}, calls: map[string]context.CancelFunc{}}
	for i := range mcpTools {
		s.tools[mcpTools[i].Name] = &mcpTools[i]
	}
	return s
}

// decodeJSON is one JSON value, with numbers kept as json.Number.
func decodeJSON(raw []byte) (any, error) {
	if !json.Valid(raw) {
		return nil, errors.New("not JSON")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	err := dec.Decode(&v)
	return v, err
}

// handle answers one parsed message, or a batch; nil when it gets no reply, as a notification or a cancelled request
// doesn't. notify sends the client a notification while a request works, such as its progress.
func (s *mcpServer) handle(ctx context.Context, message any, notify func(any)) any {
	batch, ok := message.([]any)
	if !ok {
		return s.one(ctx, message, notify)
	}
	if len(batch) == 0 {
		return failure(nil, rpcInvalidRequest, "Invalid request: an empty batch")
	}
	answers := make([]any, len(batch))
	var wg sync.WaitGroup
	for i, item := range batch {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answers[i] = s.one(ctx, item, notify)
		}()
	}
	wg.Wait()
	var out []any
	for _, a := range answers {
		if a != nil {
			out = append(out, a)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func (s *mcpServer) one(ctx context.Context, message any, notify func(any)) (answer any) {
	m, ok := message.(map[string]any)
	if !ok {
		return failure(nil, rpcInvalidRequest, "Invalid request")
	}
	method, ok := m["method"].(string)
	if !ok {
		// A response from the client (this server sends no requests) gets no reply.
		_, result := m["result"]
		_, failed := m["error"]
		if result || failed {
			return nil
		}
		return failure(idOf(m["id"]), rpcInvalidRequest, "Invalid request: no method")
	}
	// A notification: no id, or one of MCP's. Only a cancellation needs anything from this server: the wait it names
	// stops, and its answer isn't sent.
	if _, hasID := m["id"]; !hasID || strings.HasPrefix(method, "notifications/") {
		if params, ok := m["params"].(map[string]any); ok && method == "notifications/cancelled" {
			if key, ok := callKey(idOf(params["requestId"])); ok {
				s.mu.Lock()
				cancel := s.calls[key]
				s.mu.Unlock()
				if cancel != nil {
					cancel()
				}
			}
		}
		return nil
	}
	id := idOf(m["id"])
	if m["jsonrpc"] != "2.0" {
		return failure(id, rpcInvalidRequest, `Invalid request: jsonrpc must be "2.0"`)
	}
	params, _ := m["params"].(map[string]any)
	if params == nil {
		params = map[string]any{}
	}
	defer func() {
		if r := recover(); r != nil {
			s.log(fmt.Sprintf("kantel mcp: %s failed: %v", method, r))
			answer = failure(id, rpcInternalError, "Internal error")
		}
	}()
	switch method {
	case "initialize":
		version := protocolVersions[0]
		if requested, ok := params["protocolVersion"].(string); ok && has(protocolVersions, requested) {
			version = requested
		}
		return success(id, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "kantel", "version": s.version},
			"instructions":    mcpInstructions,
		})
	case "ping":
		return success(id, map[string]any{})
	case "tools/list":
		return success(id, map[string]any{"tools": toolDefinitions()})
	case "tools/call":
		return s.callTool(ctx, id, params, notify)
	}
	return failure(id, rpcMethodNotFound, "Method not found: "+method)
}

func (s *mcpServer) callTool(parent context.Context, id any, params map[string]any, notify func(any)) any {
	name, ok := params["name"].(string)
	if !ok {
		return failure(id, rpcInvalidParams, "Invalid params: name is required")
	}
	tool := s.tools[name]
	if tool == nil {
		return failure(id, rpcInvalidParams, "Unknown tool: "+name)
	}
	var args toolArgs
	switch raw := params["arguments"].(type) {
	case nil:
		args = toolArgs{}
	case map[string]any:
		args = raw
	default:
		return success(id, errorResult("Invalid arguments: arguments must be an object", nil))
	}
	if problem := validateArguments(tool.Schema, args); problem != "" {
		return success(id, errorResult("Invalid arguments: "+problem, nil))
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	key, keyed := callKey(id)
	if keyed {
		s.mu.Lock()
		s.calls[key] = cancel
		s.mu.Unlock()
		defer func() {
			s.mu.Lock()
			delete(s.calls, key)
			s.mu.Unlock()
		}()
	}
	// MCP's progress must go up with every notification, so it counts them; the time is in the message.
	meta, _ := params["_meta"].(map[string]any)
	token := idOf(meta["progressToken"])
	stopTicker := func() {}
	if notify != nil && token != nil {
		done := make(chan struct{})
		stopped := make(chan struct{})
		started := time.Now()
		go func() {
			defer close(stopped)
			ticker := time.NewTicker(s.progressEvery)
			defer ticker.Stop()
			for ticks := 1; ; ticks++ {
				select {
				case <-done:
					return
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
				notify(rpcNotification{JSONRPC: "2.0", Method: "notifications/progress", Params: map[string]any{
					"progressToken": token, "progress": ticks,
					"message": fmt.Sprintf("%s: still working after %d s", name, int(math.Round(time.Since(started).Seconds()))),
				}})
			}
		}()
		stopTicker = func() {
			close(done)
			<-stopped
		}
	}
	type outcome struct {
		result toolResult
		err    error
	}
	finished := make(chan outcome, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				finished <- outcome{err: fmt.Errorf("%v", r)}
			}
		}()
		result, err := tool.call(ctx, toolContext{client: s.client, account: s.account, poll: s.pollEvery}, args)
		finished <- outcome{result, err}
	}()
	// A cancellation ends the call at once, whatever its tool is waiting on: no more progress, and no answer.
	var o outcome
	select {
	case o = <-finished:
	case <-ctx.Done():
	}
	stopTicker()
	if ctx.Err() != nil {
		return nil
	}
	if o.err == nil {
		return success(id, o.result)
	}
	var apiErr *api.Error
	var argErr *argumentError
	switch {
	case errors.As(o.err, &apiErr):
		return success(id, kantelErrorResult(apiErr))
	case errors.As(o.err, &argErr):
		return success(id, errorResult("Invalid arguments: "+argErr.message, nil))
	}
	s.log(fmt.Sprintf("kantel mcp: %s failed: %s", name, o.err))
	return success(id, errorResult(o.err.Error(), nil))
}

// serveMCP serves s on stdio: one JSON-RPC message a line in, one answer (or notification) a line out. Requests are
// handled as they arrive, so a long command doesn't hold up a ping or its own cancellation. It returns once in ends
// and every answer is written.
func serveMCP(ctx context.Context, s *mcpServer, in io.Reader, out, errOut io.Writer) error {
	var mu sync.Mutex
	write := func(v any) {
		line := jsonText(v) + "\n"
		mu.Lock()
		defer mu.Unlock()
		_, _ = io.WriteString(out, line)
	}
	var wg sync.WaitGroup
	dispatch := func(line string) {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			return
		}
		message, err := decodeJSON([]byte(trimmed))
		if err != nil {
			write(failure(nil, rpcParseError, "Parse error"))
			return
		}
		// In the order they came: a notification (a cancellation) is handled before the next message is read, and a
		// tool call is registered before then too, so a cancellation sent straight after its call always finds it.
		m, _ := message.(map[string]any)
		method, _ := m["method"].(string)
		if _, hasID := m["id"]; m != nil && (!hasID || strings.HasPrefix(method, "notifications/")) {
			s.handle(ctx, message, write)
			return
		}
		callCtx, cancel := context.WithCancel(ctx)
		if key, keyed := callKey(idOf(m["id"])); keyed && method == "tools/call" {
			s.mu.Lock()
			s.calls[key] = cancel
			s.mu.Unlock()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer cancel()
			defer func() {
				if r := recover(); r != nil {
					fmt.Fprintf(errOut, "kantel mcp: %v\n", r)
					var id any
					if m, ok := message.(map[string]any); ok {
						id = idOf(m["id"])
					}
					write(failure(id, rpcInternalError, "Internal error"))
				}
			}()
			if answer := s.handle(callCtx, message, write); answer != nil {
				write(answer)
			}
		}()
	}
	r := bufio.NewReader(in)
	for {
		line, err := r.ReadString('\n')
		dispatch(line)
		if err != nil {
			break
		}
	}
	wg.Wait()
	return nil
}
