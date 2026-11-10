package cli

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// DefaultURL is where Kantel is when nothing says otherwise: the hosted gateway. A self-hosted one is given with --url.
const DefaultURL = "https://app.kantel.dev"

// Env is the environment a command runs in.
type Env map[string]string

// Lookup is a variable and whether it is set.
func (e Env) Lookup(name string) (string, bool) {
	v, ok := e[name]
	return v, ok
}

// Get is a variable, or "".
func (e Env) Get(name string) string { return e[name] }

// EnvOf is the process's environment.
func EnvOf(environ []string) Env {
	env := Env{}
	for _, kv := range environ {
		if k, v, ok := strings.Cut(kv, "="); ok {
			env[k] = v
		}
	}
	return env
}

// Stored is what config.json holds.
type Stored struct {
	URL     string `json:"url,omitempty"`
	APIKey  string `json:"apiKey,omitempty"`
	Account string `json:"account,omitempty"`
}

// Settings are where a command finds Kantel and its credential.
type Settings struct {
	// URL is the API's base URL, <origin>/v1.
	URL     string
	APIKey  string
	Account string
}

// ConfigDir is where config.json is: ${XDG_CONFIG_HOME:-~/.config}/kantel.
func ConfigDir(env Env, home string) string {
	if xdg := env.Get("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, "kantel")
	}
	return filepath.Join(home, ".config", "kantel")
}

var (
	localHost  = regexp.MustCompile(`(?i)^(localhost|127\.|0\.0\.0\.0|\[::1\])`)
	withScheme = regexp.MustCompile(`(?i)^[a-z][a-z\d+.-]*://`)
)

// NormaliseURL is Kantel's API base URL from what someone typed: <origin>/v1, whether or not /v1 (or any path) was
// given. A bare host gets https://, or http:// when it is local.
func NormaliseURL(input string) (string, error) {
	trimmed := strings.TrimSpace(input)
	if !withScheme.MatchString(trimmed) {
		if localHost.MatchString(trimmed) {
			trimmed = "http://" + trimmed
		} else {
			trimmed = "https://" + trimmed
		}
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Host == "" {
		return "", Usage(`"` + input + `" isn't a URL`)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", Usage(`"` + input + `" isn't an http(s) URL`)
	}
	return u.Scheme + "://" + u.Host + "/v1", nil
}

// Origin is an API base URL without /v1, for people to read.
func Origin(apiURL string) string { return strings.TrimSuffix(strings.TrimSuffix(apiURL, "/"), "/v1") }

func first(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// Resolve takes each setting from the flags, else the environment, else the file; the URL else defaultURL.
func Resolve(flags Settings, env Env, stored Stored, defaultURL string) (Settings, error) {
	u, err := NormaliseURL(first(flags.URL, env.Get("KANTEL_URL"), stored.URL, defaultURL))
	if err != nil {
		return Settings{}, err
	}
	return Settings{
		URL:     u,
		APIKey:  first(flags.APIKey, env.Get("KANTEL_API_KEY"), stored.APIKey),
		Account: first(flags.Account, env.Get("KANTEL_ACCOUNT"), stored.Account),
	}, nil
}

// ReadStored is what config.json in dir holds; nothing when there is no file.
func ReadStored(dir string) (Stored, error) {
	path := filepath.Join(dir, "config.json")
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Stored{}, nil
	}
	if err != nil {
		return Stored{}, err
	}
	var s Stored
	if err := json.Unmarshal(raw, &s); err != nil {
		return Stored{}, Fail(path + " isn't valid JSON: fix it or delete it and run kantel login again")
	}
	return s, nil
}

// WriteStored writes config.json in dir, readable by its owner only (0600), making the directory (0700) if need be,
// and answers its path. It is written beside and renamed into place, so a reader never sees half of it.
func WriteStored(dir string, s Stored) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "config.json")
	raw, _ := json.MarshalIndent(s, "", "\t")
	return path, WriteFileAtomic(path, append(raw, '\n'), 0o600)
}

// WriteFileAtomic writes data to path through a file beside it, renamed into place, with mode.
func WriteFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
