// Package signing is kantel-host's side of a microVM's Git signing: the sandbox's private key, fetched from Kantel
// (signing.fetch) and held in this process's memory only, signs the Git commits and annotated tags the guest's
// kantel-sign sends over vsock (guest.SignPort), and nothing else. The key never enters the sandbox: not its disk, its
// environment, its snapshots, its forks or meta.json.
package signing

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
)

// MaxPayloadBytes is the largest object the host signs: a commit or tag far larger than any real one is refused.
const MaxPayloadBytes = 256 * 1024

// Object types ParseGitObject answers.
const (
	ObjectCommit = "commit"
	ObjectTag    = "tag"
)

// ParsedObject is what the host reads from a Git object before it signs it.
type ParsedObject struct {
	// Type is ObjectCommit or ObjectTag.
	Type string
	// CommitterEmail is the commit's committer's or the tag's tagger's email, lower-cased: who the signature vouches
	// for, checked against the key's allowed emails.
	CommitterEmail string
	// ObjectHash is a commit's tree, or the object a tag points at.
	ObjectHash string
}

// ErrNotGitObject is a payload that is neither a Git commit nor an annotated tag: arbitrary text, a certificate, a
// token, a login challenge or an email is never signed.
var ErrNotGitObject = errors.New("the payload isn't a Git commit or annotated tag")

// ParseGitObject validates payload as an unsigned Git commit or annotated tag object, as Git hands one to its signing
// program, and answers what it says.
func ParseGitObject(payload []byte) (ParsedObject, error) {
	switch {
	case len(payload) == 0:
		return ParsedObject{}, errors.New("the payload is empty")
	case len(payload) > MaxPayloadBytes:
		return ParsedObject{}, fmt.Errorf("the payload is over %d bytes", MaxPayloadBytes)
	case bytes.IndexByte(payload, 0) >= 0:
		return ParsedObject{}, fmt.Errorf("%w: it holds a NUL byte", ErrNotGitObject)
	}
	text := string(payload)
	switch {
	case strings.HasPrefix(text, "tree "):
		return parseCommit(text)
	case strings.HasPrefix(text, "object "):
		return parseTag(text, false)
	}
	return ParsedObject{}, ErrNotGitObject
}

// splitObject splits an object into its header lines and its message, at the first blank line, which every object
// Git writes has.
func splitObject(text string) ([]string, string, error) {
	header, body, ok := strings.Cut(text, "\n\n")
	if !ok || header == "" {
		return nil, "", fmt.Errorf("%w: no header ended by a blank line", ErrNotGitObject)
	}
	return strings.Split(header, "\n"), body, nil
}

// parseCommit reads a commit: tree, its parents, author, committer, then optionally encoding, mergetag and change-id.
// A gpgsig or gpgsig-sha256 header (an object already signed) or any other header is refused.
func parseCommit(text string) (ParsedObject, error) {
	lines, _, err := splitObject(text)
	if err != nil {
		return ParsedObject{}, err
	}
	bad := func(format string, args ...any) (ParsedObject, error) {
		return ParsedObject{}, fmt.Errorf("%w: "+format, append([]any{ErrNotGitObject}, args...)...)
	}
	tree, ok := strings.CutPrefix(lines[0], "tree ")
	if !ok || !isObjectHash(tree) {
		return bad("its tree isn't an object hash")
	}
	i := 1
	for i < len(lines) && strings.HasPrefix(lines[i], "parent ") {
		if !isObjectHash(strings.TrimPrefix(lines[i], "parent ")) {
			return bad("a parent isn't an object hash")
		}
		i++
	}
	if i >= len(lines) || !strings.HasPrefix(lines[i], "author ") {
		return bad("it has no author after its tree and parents")
	}
	if _, err := parseIdent(strings.TrimPrefix(lines[i], "author ")); err != nil {
		return bad("its author: %v", err)
	}
	i++
	if i >= len(lines) || !strings.HasPrefix(lines[i], "committer ") {
		return bad("it has no committer after its author")
	}
	email, err := parseIdent(strings.TrimPrefix(lines[i], "committer "))
	if err != nil {
		return bad("its committer: %v", err)
	}
	i++
	encoding := false
	for i < len(lines) {
		key, value, _ := strings.Cut(lines[i], " ")
		i++
		switch key {
		case "encoding":
			if encoding || !isPrintable(value) {
				return bad("its encoding header is repeated or malformed")
			}
			encoding = true
		case "mergetag":
			// The tag a merge merged, folded: each line after its first starts with a space.
			tag := []string{value}
			for i < len(lines) && strings.HasPrefix(lines[i], " ") {
				tag = append(tag, lines[i][1:])
				i++
			}
			if _, err := parseTag(strings.Join(tag, "\n"), true); err != nil {
				return bad("its mergetag header isn't a tag")
			}
		case "change-id":
			if !isPrintable(value) {
				return bad("its change-id header is malformed")
			}
		case "gpgsig", "gpgsig-sha256":
			return bad("it is signed already")
		case "author", "committer", "tree", "parent":
			return bad("its headers are out of order or repeated")
		default:
			return bad("it has a header Git doesn't write")
		}
	}
	return ParsedObject{Type: ObjectCommit, CommitterEmail: email, ObjectHash: tree}, nil
}

// signatureMarkers are what a signed tag's message ends with.
var signatureMarkers = []string{"-----BEGIN PGP SIGNATURE-----", "-----BEGIN SSH SIGNATURE-----"}

// parseTag reads an annotated tag: object, type, tag and tagger, in that order and nothing else. signed allows its
// message to hold a signature already (a merge's mergetag); a tag to be signed mustn't.
func parseTag(text string, signed bool) (ParsedObject, error) {
	lines, body, err := splitObject(text)
	if err != nil {
		return ParsedObject{}, err
	}
	bad := func(what string) (ParsedObject, error) {
		return ParsedObject{}, fmt.Errorf("%w: %s", ErrNotGitObject, what)
	}
	if len(lines) != 4 {
		return bad("a tag's header is object, type, tag and tagger")
	}
	object, ok := strings.CutPrefix(lines[0], "object ")
	if !ok || !isObjectHash(object) {
		return bad("its object isn't an object hash")
	}
	if typ, ok := strings.CutPrefix(lines[1], "type "); !ok || (typ != "commit" && typ != "tree" && typ != "blob" && typ != "tag") {
		return bad("its type isn't commit, tree, blob or tag")
	}
	name, ok := strings.CutPrefix(lines[2], "tag ")
	if !ok || name == "" || strings.ContainsFunc(name, func(r rune) bool { return r <= ' ' || r == 0x7f }) {
		return bad("its tag name is missing or malformed")
	}
	tagger, ok := strings.CutPrefix(lines[3], "tagger ")
	if !ok {
		return bad("it has no tagger")
	}
	email, err := parseIdent(tagger)
	if err != nil {
		return bad("its tagger: " + err.Error())
	}
	if !signed {
		for _, marker := range signatureMarkers {
			if strings.Contains(body, marker) {
				return bad("it is signed already")
			}
		}
	}
	return ParsedObject{Type: ObjectTag, CommitterEmail: email, ObjectHash: object}, nil
}

// parseIdent reads an author, committer or tagger, "Name <email> 1700000000 +0100", and answers its email,
// lower-cased.
func parseIdent(ident string) (string, error) {
	rest, tz, ok := cutLast(ident, " ")
	if !ok || !isTimezone(tz) {
		return "", errors.New("no timezone")
	}
	rest, when, ok := cutLast(rest, " ")
	if !ok || when == "" || len(when) > 20 || strings.ContainsFunc(when, func(r rune) bool { return r < '0' || r > '9' }) {
		return "", errors.New("no timestamp")
	}
	name, addr, ok := strings.Cut(rest, " <")
	if !ok || !strings.HasSuffix(addr, ">") {
		return "", errors.New("no <email>")
	}
	email := strings.TrimSuffix(addr, ">")
	if strings.TrimSpace(name) == "" || strings.ContainsAny(name, "<>\n\r\x00") {
		return "", errors.New("no name")
	}
	if email == "" || !strings.Contains(email, "@") || strings.ContainsFunc(email, func(r rune) bool {
		return r <= ' ' || r == '<' || r == '>' || r == 0x7f
	}) {
		return "", errors.New("a malformed email")
	}
	return strings.ToLower(email), nil
}

func cutLast(s, sep string) (before, after string, ok bool) {
	i := strings.LastIndex(s, sep)
	if i < 0 {
		return s, "", false
	}
	return s[:i], s[i+len(sep):], true
}

func isTimezone(tz string) bool {
	if len(tz) != 5 || (tz[0] != '+' && tz[0] != '-') {
		return false
	}
	for _, c := range tz[1:] {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// isObjectHash is a SHA-1 or SHA-256 object name, as Git writes it: lower-case hex.
func isObjectHash(h string) bool {
	if len(h) != 40 && len(h) != 64 {
		return false
	}
	for _, c := range h {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// isPrintable is non-empty printable ASCII.
func isPrintable(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < ' ' || c > '~' {
			return false
		}
	}
	return true
}
