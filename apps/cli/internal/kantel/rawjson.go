package kantel

import (
	"bytes"
	"encoding/json"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// Kantel's answers kept as it sent them, in its order, for --json: read and changed without losing that order.

// member is one of a JSON object's keys and its value, as sent.
type member struct {
	Key   string
	Value json.RawMessage
}

// objectMembers is a JSON object's members in order; false when raw isn't an object.
func objectMembers(raw json.RawMessage) ([]member, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	if _, err := dec.Token(); err != nil {
		return nil, false
	}
	var out []member
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, false
		}
		key, ok := tok.(string)
		if !ok {
			return nil, false
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, false
		}
		out = append(out, member{key, value})
	}
	return out, true
}

// arrayItems is a JSON array's items; false when raw isn't an array.
func arrayItems(raw json.RawMessage) ([]json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(trimmed, &items); err != nil {
		return nil, false
	}
	return items, true
}

func marshalKey(key string) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(key)
	return bytes.TrimRight(b.Bytes(), "\n")
}

// joinObject is members as a JSON object, in their order.
func joinObject(members []member) json.RawMessage {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, m := range members {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(marshalKey(m.Key))
		b.WriteByte(':')
		b.Write(m.Value)
	}
	b.WriteByte('}')
	return b.Bytes()
}

// joinArray is items as a JSON array.
func joinArray(items []json.RawMessage) json.RawMessage {
	var b bytes.Buffer
	b.WriteByte('[')
	for i, item := range items {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(item)
	}
	b.WriteByte(']')
	return b.Bytes()
}

// withMember is the object raw with key's value replaced by value.
func withMember(raw json.RawMessage, key string, value json.RawMessage) json.RawMessage {
	members, ok := objectMembers(raw)
	if !ok {
		return raw
	}
	for i := range members {
		if members[i].Key == key {
			members[i].Value = value
		}
	}
	return joinObject(members)
}

// memberOf is the value of an object's key, or nil.
func memberOf(raw json.RawMessage, key string) json.RawMessage {
	members, _ := objectMembers(raw)
	for _, m := range members {
		if m.Key == key {
			return m.Value
		}
	}
	return nil
}

// WithoutProtectedValues is raw with the value of anything marked "protected": true left out, at any depth. Kantel
// never answers a protected variable's value; this makes sure the command line never prints one, even with --json.
func WithoutProtectedValues(raw json.RawMessage) json.RawMessage {
	if members, ok := objectMembers(raw); ok {
		protected := false
		for _, m := range members {
			if m.Key == "protected" && bytes.Equal(bytes.TrimSpace(m.Value), []byte("true")) {
				protected = true
			}
		}
		kept := make([]member, 0, len(members))
		for _, m := range members {
			if m.Key == "value" && protected {
				continue
			}
			kept = append(kept, member{m.Key, WithoutProtectedValues(m.Value)})
		}
		return joinObject(kept)
	}
	if items, ok := arrayItems(raw); ok {
		for i := range items {
			items[i] = WithoutProtectedValues(items[i])
		}
		return joinArray(items)
	}
	return raw
}

// emitWithoutProtectedValues is c.Emit with protected values left out of the JSON: Kantel's answer, or value when
// there was none.
func emitWithoutProtectedValues(c *cli.Context, raw json.RawMessage, value any, human func() string) {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw, _ = json.Marshal(value)
	}
	c.Emit(WithoutProtectedValues(raw), value, human)
}
