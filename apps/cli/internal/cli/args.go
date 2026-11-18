package cli

import (
	"strings"
)

// FlagType is what a flag takes.
type FlagType int

const (
	String FlagType = iota
	Bool
)

// Flag is one flag a command takes.
type Flag struct {
	Name string
	Type FlagType
	// Multiple keeps each value, in order.
	Multiple bool
	// Short is a one-letter alias, such as h for -h.
	Short string
	// Value is the value's placeholder in help, such as <minutes>.
	Value       string
	Description string
	// Hidden leaves it out of help, such as an old spelling.
	Hidden bool
	// Choices are the values it takes, for completion (and help's schema).
	Choices []string
}

// Parsed is a command line read against its flags.
type Parsed struct {
	strings  map[string][]string
	bools    map[string]bool
	Args     []string
	Rest     []string
	HasRest  bool
	Explicit map[string]bool
}

// Str is a string flag's last value, and whether it was given.
func (p *Parsed) Str(name string) (string, bool) {
	v := p.strings[name]
	if len(v) == 0 {
		return "", false
	}
	return v[len(v)-1], true
}

// List is a repeatable flag's values, in order.
func (p *Parsed) List(name string) []string { return p.strings[name] }

// Bool is a boolean flag's value; false when it wasn't given.
func (p *Parsed) Bool(name string) bool { return p.bools[name] }

// BoolSet is a boolean flag's value and whether it was given (--no-wait sets it false).
func (p *Parsed) BoolSet(name string) (bool, bool) {
	v, ok := p.bools[name]
	return v, ok
}

func findFlag(specs []Flag, name string) *Flag {
	for i := range specs {
		if specs[i].Name == name {
			return &specs[i]
		}
	}
	return nil
}

// Parse reads argv against specs: `--flag value`, `--flag=value`, repeats, booleans (`--flag`, `--flag=false`,
// `--no-flag`), one-letter aliases, and `--`, after which everything is left as it is. An unknown flag or a missing
// value is a usage error.
func Parse(argv []string, specs []Flag) (*Parsed, error) {
	p := &Parsed{strings: map[string][]string{}, bools: map[string]bool{}, Explicit: map[string]bool{}}
	set := func(f *Flag, value string) {
		p.Explicit[f.Name] = true
		if f.Multiple {
			p.strings[f.Name] = append(p.strings[f.Name], value)
		} else {
			p.strings[f.Name] = []string{value}
		}
	}
	valueAfter := func(i int, label string) (string, error) {
		if i+1 >= len(argv) || strings.HasPrefix(argv[i+1], "--") {
			return "", Usage(label + " needs a value")
		}
		return argv[i+1], nil
	}
	for i := 0; i < len(argv); i++ {
		token := argv[i]
		if token == "--" {
			p.Rest, p.HasRest = argv[i+1:], true
			break
		}
		if strings.HasPrefix(token, "--") {
			name, inline, hasInline := strings.Cut(token[2:], "=")
			f := findFlag(specs, name)
			if f == nil {
				if positive := findFlag(specs, strings.TrimPrefix(name, "no-")); strings.HasPrefix(name, "no-") &&
					positive != nil && positive.Type == Bool && !hasInline {
					p.bools[positive.Name] = false
					p.Explicit[positive.Name] = true
					continue
				}
				var names []string
				for _, s := range specs {
					if !s.Hidden {
						names = append(names, "--"+s.Name)
					}
				}
				msg := "unknown flag --" + name
				if hint := DidYouMean(Nearest("--"+name, names, 3)); hint != "" {
					msg += "." + hint
				}
				return nil, Usage(msg)
			}
			if f.Type == Bool {
				switch {
				case !hasInline || inline == "true":
					p.bools[f.Name] = true
				case inline == "false":
					p.bools[f.Name] = false
				default:
					return nil, Usage("--" + name + ` takes no value (or true or false), not "` + inline + `"`)
				}
				p.Explicit[f.Name] = true
				continue
			}
			if hasInline {
				set(f, inline)
				continue
			}
			v, err := valueAfter(i, "--"+name)
			if err != nil {
				return nil, err
			}
			set(f, v)
			i++
			continue
		}
		if len(token) > 1 && token[0] == '-' && !(token[1] >= '0' && token[1] <= '9') {
			var f *Flag
			for j := range specs {
				if specs[j].Short != "" && specs[j].Short == token[1:] {
					f = &specs[j]
				}
			}
			if f == nil {
				return nil, Usage("unknown flag " + token)
			}
			if f.Type == Bool {
				p.bools[f.Name] = true
				p.Explicit[f.Name] = true
				continue
			}
			v, err := valueAfter(i, token)
			if err != nil {
				return nil, err
			}
			set(f, v)
			i++
			continue
		}
		p.Args = append(p.Args, token)
	}
	return p, nil
}
