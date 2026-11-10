package admin

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
)

// The stack's settings file, deploy/compose/.env.

var (
	envLine = regexp.MustCompile(`^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$`)
	envKey  = regexp.MustCompile(`^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=`)
	// secretKey is a setting whose value is a secret, shown as (set).
	secretKey = regexp.MustCompile(`SECRET|TOKEN|PASSWORD|_KEY$|SMTP_URL`)
)

// Setting is one KEY=value.
type Setting struct{ Key, Value string }

// EnvSettings are .env's settings, in the order their keys first appear.
type EnvSettings []Setting

// Get is a key's value and whether it is set.
func (s EnvSettings) Get(key string) (string, bool) {
	for _, kv := range s {
		if kv.Key == key {
			return kv.Value, true
		}
	}
	return "", false
}

// ParseEnvFile reads .env's KEY=value lines, the last of a key winning (in the place of its first).
func ParseEnvFile(text string) EnvSettings {
	var out EnvSettings
	at := map[string]int{}
	for _, line := range strings.Split(text, "\n") {
		m := envLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		value := unquoteEnv(m[2])
		if i, ok := at[m[1]]; ok {
			out[i].Value = value
			continue
		}
		at[m[1]] = len(out)
		out = append(out, Setting{m[1], value})
	}
	return out
}

// Change is a key set to a value, or removed when Value is nil.
type Change struct {
	Key   string
	Value *string
}

// Changes are changes in order, a key once (at its first place, with its last value).
type Changes []Change

// Set adds a change, or replaces one to the same key.
func (cs *Changes) Set(key string, value *string) {
	for i := range *cs {
		if (*cs)[i].Key == key {
			(*cs)[i].Value = value
			return
		}
	}
	*cs = append(*cs, Change{key, value})
}

func (cs Changes) find(key string) (Change, bool) {
	for _, c := range cs {
		if c.Key == key {
			return c, true
		}
	}
	return Change{}, false
}

// MarshalJSON is the changes as an object in order, a removed key null.
func (cs Changes) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, c := range cs {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(c.Key)
		v, _ := json.Marshal(c.Value)
		b.Write(k)
		b.WriteByte(':')
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// UpdateEnvFile is text with each changed key set (or removed) in place, and new keys added at the end. The first
// line of a key takes its new value; later ones go.
func UpdateEnvFile(text string, changes Changes) string {
	done := map[string]bool{}
	var lines []string
	if text != "" {
		lines = strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	}
	var kept []string
	for _, line := range lines {
		m := envKey.FindStringSubmatch(line)
		if m == nil {
			kept = append(kept, line)
			continue
		}
		change, ok := changes.find(m[1])
		if !ok {
			kept = append(kept, line)
			continue
		}
		if !done[m[1]] && change.Value != nil {
			kept = append(kept, m[1]+"="+quoteEnv(*change.Value))
		}
		done[m[1]] = true
	}
	for _, c := range changes {
		if !done[c.Key] && c.Value != nil {
			kept = append(kept, c.Key+"="+quoteEnv(*c.Value))
		}
	}
	if len(kept) == 0 {
		return ""
	}
	return strings.Join(kept, "\n") + "\n"
}

// shownValue is a setting's value as it is shown: a secret's as (set).
func shownValue(key, value string) string {
	if secretKey.MatchString(key) && value != "" {
		return "(set)"
	}
	return value
}

// orderedObject is settings as a JSON object, in order.
type orderedObject EnvSettings

func (o orderedObject) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, kv := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(kv.Key)
		v, _ := json.Marshal(kv.Value)
		b.Write(k)
		b.WriteByte(':')
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

var plainEnvValue = regexp.MustCompile(`^[A-Za-z0-9_./:@,+=%-]*$`)

// quoteEnv is a value as .env holds it so Docker Compose reads it back as it is: plain when it can be, else in single
// quotes, which Compose takes literally (no $ interpolation, no # comment), or in double quotes with \, " and $
// escaped when it holds a single quote itself.
func quoteEnv(value string) string {
	switch {
	case plainEnvValue.MatchString(value):
		return value
	case !strings.Contains(value, "'"):
		return "'" + value + "'"
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "$", "$$").Replace(value) + `"`
}

// unquoteEnv is a value as .env holds it read back: quotes taken off, and a double-quoted one's escapes undone.
func unquoteEnv(value string) string {
	if len(value) < 2 || value[0] != value[len(value)-1] {
		return value
	}
	switch value[0] {
	case '\'':
		return value[1 : len(value)-1]
	case '"':
		return strings.NewReplacer(`\\`, `\`, `\"`, `"`, "$$", "$").Replace(value[1 : len(value)-1])
	}
	return value
}
