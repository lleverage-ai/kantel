// Command gen writes the Go API client's types and methods (types_gen.go, client_gen.go) from the public API's
// OpenAPI document, packages/api/generated/openapi.json, itself generated from packages/api/src/routes.ts: so the
// client can't drift from the routes. `-check` writes nothing and fails if either file differs.
//
//	go run ./internal/api/gen [-check]
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"go/format"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type schema struct {
	Ref                  string             `json:"$ref"`
	Type                 string             `json:"type"`
	Format               string             `json:"format"`
	Const                any                `json:"const"`
	Title                string             `json:"title"`
	Description          string             `json:"description"`
	Properties           map[string]*schema `json:"properties"`
	PatternProperties    map[string]*schema `json:"patternProperties"`
	AdditionalProperties any                `json:"additionalProperties"`
	Required             []string           `json:"required"`
	Items                *schema            `json:"items"`
	AnyOf                []*schema          `json:"anyOf"`
	OneOf                []*schema          `json:"oneOf"`
}

type parameter struct {
	Name        string  `json:"name"`
	In          string  `json:"in"`
	Required    bool    `json:"required"`
	Description string  `json:"description"`
	Schema      *schema `json:"schema"`
}

type media struct {
	Schema *schema `json:"schema"`
}

type operation struct {
	OperationID string      `json:"operationId"`
	Summary     string      `json:"summary"`
	Description string      `json:"description"`
	Parameters  []parameter `json:"parameters"`
	RequestBody *struct {
		Required bool             `json:"required"`
		Content  map[string]media `json:"content"`
	} `json:"requestBody"`
	Responses map[string]struct {
		Content map[string]media `json:"content"`
	} `json:"responses"`
}

type document struct {
	Paths      map[string]map[string]json.RawMessage `json:"paths"`
	Components struct {
		Schemas map[string]*schema `json:"schemas"`
	} `json:"components"`
}

// generator collects the types to write: the document's schemas, and the ones made for inline objects and enums.
type generator struct {
	schemas map[string]*schema
	types   map[string]string // name: its Go declaration
	order   []string
}

var initialisms = map[string]string{
	"id": "ID", "url": "URL", "api": "API", "cpu": "CPU", "json": "JSON", "ssh": "SSH", "cdp": "CDP", "ip": "IP",
	"os": "OS", "http": "HTTP", "https": "HTTPS", "uri": "URI", "ttl": "TTL", "tls": "TLS", "dns": "DNS", "uuid": "UUID",
	"vcpu": "VCPU", "vcpus": "VCPUs", "otlp": "OTLP", "sha256": "SHA256", "kvm": "KVM", "io": "IO", "oom": "OOM",
}

var wordRe = regexp.MustCompile(`[A-Z]?[a-z0-9]+|[A-Z]+(?:[A-Z][a-z]|$)?`)

// goName is a JSON name or an operationId as an exported Go name: sandboxId is SandboxID, cdpUrl CDPURL.
func goName(name string) string {
	name = strings.NewReplacer("-", " ", "_", " ", ".", " ", ":", " ", "/", " ").Replace(name)
	var out strings.Builder
	for _, field := range strings.Fields(name) {
		for _, word := range wordRe.FindAllString(field, -1) {
			if up, ok := initialisms[strings.ToLower(word)]; ok {
				out.WriteString(up)
				continue
			}
			out.WriteString(strings.ToUpper(word[:1]) + word[1:])
		}
	}
	s := out.String()
	if s == "" {
		return "X"
	}
	if s[0] >= '0' && s[0] <= '9' {
		return "N" + s
	}
	return s
}

func comment(text, indent string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	var b strings.Builder
	for _, line := range strings.Split(text, "\n") {
		b.WriteString(indent + "// " + strings.TrimRight(line, " ") + "\n")
	}
	return b.String()
}

func refName(ref string) string { return strings.TrimPrefix(ref, "#/components/schemas/") }

// isEnum says whether s is a string enum: an anyOf of string consts, or a string const.
func isEnum(s *schema) ([]string, bool) {
	if len(s.AnyOf) > 0 {
		var values []string
		for _, a := range s.AnyOf {
			v, ok := a.Const.(string)
			if !ok {
				return nil, false
			}
			values = append(values, v)
		}
		return values, true
	}
	if v, ok := s.Const.(string); ok {
		return []string{v}, true
	}
	return nil, false
}

// nullable is the other branch of an anyOf with null, or nil.
func nullable(s *schema) *schema {
	if len(s.AnyOf) != 2 {
		return nil
	}
	for i, a := range s.AnyOf {
		if a.Type == "null" {
			return s.AnyOf[1-i]
		}
	}
	return nil
}

func (g *generator) add(name, decl string) {
	if _, ok := g.types[name]; ok {
		return
	}
	g.types[name] = decl
	g.order = append(g.order, name)
}

// goType is the Go type of s, named after `hint` when it needs a type of its own (an inline object or enum).
func (g *generator) goType(s *schema, hint string) string {
	if s == nil {
		return "json.RawMessage"
	}
	if s.Ref != "" {
		return goName(refName(s.Ref))
	}
	if inner := nullable(s); inner != nil {
		return "Nullable[" + g.goType(inner, hint) + "]"
	}
	if values, ok := isEnum(s); ok {
		g.enum(hint, s.Description, values)
		return hint
	}
	if len(s.AnyOf) > 0 || len(s.OneOf) > 0 {
		// A union of objects: kept as its JSON, which the caller reads as the branch it expects.
		g.add(hint, comment(s.Description, "")+"type "+hint+" = json.RawMessage\n")
		return hint
	}
	switch s.Type {
	case "string":
		return "string"
	case "integer":
		return "int64"
	case "number":
		return "float64"
	case "boolean":
		return "bool"
	case "array":
		return "[]" + g.goType(s.Items, hint+"Item")
	case "object":
		for _, p := range s.PatternProperties {
			return "map[string]" + g.goType(p, hint+"Value")
		}
		if len(s.Properties) == 0 {
			if extra, ok := s.AdditionalProperties.(map[string]any); ok && len(extra) > 0 {
				return "map[string]json.RawMessage"
			}
			return "map[string]json.RawMessage"
		}
		g.object(hint, s)
		return hint
	}
	return "json.RawMessage"
}

func (g *generator) enum(name, description string, values []string) {
	var b strings.Builder
	b.WriteString(comment(description, ""))
	b.WriteString("type " + name + " string\n\nconst (\n")
	for _, v := range values {
		b.WriteString(fmt.Sprintf("\t%s%s %s = %q\n", name, goName(v), name, v))
	}
	b.WriteString(")\n")
	g.add(name, b.String())
}

func (g *generator) object(name string, s *schema) {
	if _, ok := g.types[name]; ok {
		return
	}
	g.types[name] = "" // reserved, so a type that refers to itself doesn't loop
	required := map[string]bool{}
	for _, r := range s.Required {
		required[r] = true
	}
	keys := make([]string, 0, len(s.Properties))
	for k := range s.Properties {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(comment(s.Description, ""))
	b.WriteString("type " + name + " struct {\n")
	for _, key := range keys {
		p := s.Properties[key]
		field := goName(key)
		t := g.goType(p, name+field)
		tag := key
		switch {
		case strings.HasPrefix(t, "Nullable["):
			if !required[key] {
				tag += ",omitzero"
			}
		case required[key]:
		case strings.HasPrefix(t, "[]") || strings.HasPrefix(t, "map[") || t == "json.RawMessage" || g.isRaw(t):
			tag += ",omitempty"
		default:
			t = "*" + t
			tag += ",omitempty"
		}
		b.WriteString(comment(p.Description, "\t"))
		b.WriteString(fmt.Sprintf("\t%s %s `json:%q`\n", field, t, tag))
	}
	b.WriteString("}\n")
	g.types[name] = b.String()
	g.order = append(g.order, name)
}

func (g *generator) isRaw(name string) bool {
	return strings.Contains(g.types[name], "= json.RawMessage")
}

// method is one operation's Go method, and the types it needs.
func (g *generator) method(path, verb string, op operation) string {
	name := goName(op.OperationID)
	var params, pathArgs []string
	var queryFields []parameter
	idempotent := false
	pathExpr := regexp.MustCompile(`\{([^}]+)\}`).ReplaceAllStringFunc(path, func(m string) string {
		arg := strings.Trim(m, "{}")
		goArg := strings.ToLower(goName(arg)[:1]) + goName(arg)[1:]
		pathArgs = append(pathArgs, goArg)
		return "%s"
	})
	for _, p := range op.Parameters {
		switch p.In {
		case "query":
			queryFields = append(queryFields, p)
		case "header":
			if strings.EqualFold(p.Name, "idempotency-key") {
				idempotent = true
			}
		}
	}
	for _, a := range pathArgs {
		params = append(params, a+" string")
	}
	query := "nil"
	if len(queryFields) > 0 {
		qname := name + "Query"
		var b strings.Builder
		b.WriteString("// " + qname + " is " + name + "'s query.\ntype " + qname + " struct {\n")
		var enc strings.Builder
		for _, p := range queryFields {
			field := goName(p.Name)
			t := g.goType(p.Schema, qname+field)
			if !strings.HasPrefix(t, "map[") && !strings.HasPrefix(t, "[]") {
				t = "*" + t
			}
			b.WriteString(comment(p.Description, "\t"))
			b.WriteString(fmt.Sprintf("\t%s %s\n", field, t))
			enc.WriteString(fmt.Sprintf("\tsetQuery(v, %q, q.%s)\n", p.Name, field))
		}
		b.WriteString("}\n\nfunc (q *" + qname + ") values() url.Values {\n\tv := url.Values{}\n\tif q == nil {\n\t\treturn v\n\t}\n")
		b.WriteString(enc.String())
		b.WriteString("\treturn v\n}\n")
		g.add(qname, b.String())
		params = append(params, "query *"+qname)
		query = "query.values()"
	}
	body, raw := "nil", false
	if op.RequestBody != nil {
		if m, ok := op.RequestBody.Content["application/json"]; ok {
			t := g.goType(m.Schema, name+"Body")
			params = append(params, "body "+t)
			body = "body"
		} else {
			raw = true
			params = append(params, "body io.Reader", "contentType string")
		}
	}
	params = append(params, "opts ...CallOption")
	out := ""
	for _, code := range []string{"200", "201", "202"} {
		if r, ok := op.Responses[code]; ok {
			if m, ok := r.Content["application/json"]; ok {
				out = g.goType(m.Schema, name+"Response")
			}
			break
		}
	}
	if _, ok := op.Responses["200"].Content["text/event-stream"]; ok {
		return "" // a stream, read over its own call
	}
	var b strings.Builder
	doc := op.Summary
	if op.Description != "" {
		doc += ". " + op.Description
	}
	b.WriteString(comment(fmt.Sprintf("%s %s: %s", name, strings.ToUpper(verb)+" "+path, doc), ""))
	ret := "error"
	if out != "" {
		ret = "(*" + out + ", error)"
	}
	b.WriteString(fmt.Sprintf("func (c *Client) %s(ctx context.Context, %s) %s {\n", name, strings.Join(params, ", "), ret))
	pathValue := fmt.Sprintf("%q", path)
	if len(pathArgs) > 0 {
		escaped := make([]string, len(pathArgs))
		for i, a := range pathArgs {
			escaped[i] = "url.PathEscape(" + a + ")"
		}
		pathValue = fmt.Sprintf("fmt.Sprintf(%q, %s)", pathExpr, strings.Join(escaped, ", "))
	}
	callFields := fmt.Sprintf("Method: %q, Path: %s, Query: %s", strings.ToUpper(verb), pathValue, query)
	if raw {
		callFields += ", Raw: body, ContentType: contentType"
	} else if body != "nil" {
		callFields += ", Body: " + body
	}
	if idempotent {
		callFields += ", Idempotent: true"
	}
	if out != "" {
		b.WriteString("\tvar out " + out + "\n")
		b.WriteString(fmt.Sprintf("\tif err := c.Do(ctx, Call{%s, Out: &out}, opts...); err != nil {\n\t\treturn nil, err\n\t}\n\treturn &out, nil\n}\n", callFields))
	} else {
		b.WriteString(fmt.Sprintf("\treturn c.Do(ctx, Call{%s}, opts...)\n}\n", callFields))
	}
	return b.String()
}

func main() {
	check := flag.Bool("check", false, "write nothing; fail if the generated files are out of date")
	flag.Parse()
	root := findRoot()
	raw, err := os.ReadFile(filepath.Join(root, "packages/api/generated/openapi.json"))
	if err != nil {
		fail(err)
	}
	var doc document
	if err := json.Unmarshal(raw, &doc); err != nil {
		fail(err)
	}
	g := &generator{schemas: doc.Components.Schemas, types: map[string]string{}}
	names := make([]string, 0, len(doc.Components.Schemas))
	for n := range doc.Components.Schemas {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		s := doc.Components.Schemas[n]
		t := g.goType(s, goName(n))
		if t != goName(n) {
			g.add(goName(n), comment(s.Description, "")+"type "+goName(n)+" = "+t+"\n")
		}
	}
	paths := make([]string, 0, len(doc.Paths))
	for p := range doc.Paths {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	var methods []string
	for _, p := range paths {
		verbs := make([]string, 0)
		for v := range doc.Paths[p] {
			verbs = append(verbs, v)
		}
		sort.Strings(verbs)
		for _, v := range verbs {
			var op operation
			if json.Unmarshal(doc.Paths[p][v], &op) != nil || op.OperationID == "" {
				continue
			}
			if m := g.method(p, v, op); m != "" {
				methods = append(methods, m)
			}
		}
	}
	header := "// Code generated by go run ./internal/api/gen from packages/api/generated/openapi.json. DO NOT EDIT.\n\npackage api\n\n"
	sort.Strings(g.order)
	var types bytes.Buffer
	types.WriteString(header + "import \"encoding/json\"\n\nvar _ json.RawMessage\n\n")
	for _, n := range g.order {
		if strings.Contains(g.types[n], "url.Values") {
			continue
		}
		types.WriteString(g.types[n] + "\n")
	}
	var client bytes.Buffer
	client.WriteString(header + "import (\n\t\"context\"\n\t\"fmt\"\n\t\"io\"\n\t\"net/url\"\n)\n\nvar (\n\t_ = fmt.Sprintf\n\t_ io.Reader\n)\n\n")
	for _, n := range g.order {
		if strings.Contains(g.types[n], "url.Values") {
			client.WriteString(g.types[n] + "\n")
		}
	}
	client.WriteString(strings.Join(methods, "\n"))
	stale := false
	for file, content := range map[string][]byte{"types_gen.go": types.Bytes(), "client_gen.go": client.Bytes()} {
		formatted, err := format.Source(content)
		if err != nil {
			os.WriteFile(filepath.Join(os.TempDir(), file), content, 0o644)
			fail(fmt.Errorf("%s: %w", file, err))
		}
		path := filepath.Join(root, "apps/cli/internal/api", file)
		if *check {
			current, _ := os.ReadFile(path)
			if !bytes.Equal(current, formatted) {
				fmt.Fprintf(os.Stderr, "%s is out of date: run go run ./internal/api/gen in apps/cli\n", path)
				stale = true
			}
			continue
		}
		if err := os.WriteFile(path, formatted, 0o644); err != nil {
			fail(err)
		}
	}
	if stale {
		os.Exit(1)
	}
}

// findRoot is the repository's root: the directory above this one that holds packages/api.
func findRoot() string {
	dir, _ := os.Getwd()
	for {
		if _, err := os.Stat(filepath.Join(dir, "packages/api/generated/openapi.json")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			fail(fmt.Errorf("no packages/api/generated/openapi.json above %s", dir))
		}
		dir = parent
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "gen:", err)
	os.Exit(1)
}
