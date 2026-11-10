package kantel

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// `kantel login` in the browser is the device sign-in (POST /v1/auth/device, RFC 8628 style): the CLI asks Kantel
// for a code, shows it with the console page that approves it (and opens that page when it can), then polls until a
// person approves or denies it there or it expires. A sign-in still waiting is kept in login-pending.json beside
// config.json (0600), so a second `kantel login` shows the same code, and an agent with no terminal can start it with
// one command and wait for it with another (`kantel login --wait`).

type pendingLogin struct {
	URL                     string `json:"url"`
	DeviceCode              string `json:"deviceCode"`
	UserCode                string `json:"userCode"`
	VerificationURL         string `json:"verificationUrl"`
	VerificationURLComplete string `json:"verificationUrlComplete"`
	IntervalSeconds         int64  `json:"intervalSeconds"`
	ExpiresAt               int64  `json:"expiresAt"`
	Personal                bool   `json:"personal,omitempty"`
	// Requested is what was asked for: personal (a token) or key (--account-key).
	Requested string `json:"requested,omitempty"`
}

func (p pendingLogin) requested() string {
	if p.Requested != "" {
		return p.Requested
	}
	if p.Personal {
		return "personal"
	}
	return "key"
}

func pendingPath(dir string) string { return filepath.Join(dir, "login-pending.json") }

func readPending(dir, url string, at time.Time) *pendingLogin {
	raw, err := os.ReadFile(pendingPath(dir))
	if err != nil {
		return nil
	}
	var p pendingLogin
	if json.Unmarshal(raw, &p) != nil || p.DeviceCode == "" || p.URL != url || p.ExpiresAt <= at.UnixMilli() {
		return nil
	}
	return &p
}

func keepPending(dir string, p pendingLogin) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	raw, _ := json.MarshalIndent(p, "", "\t")
	return cli.WriteFileAtomic(pendingPath(dir), append(raw, '\n'), 0o600)
}

func forgetPending(dir string) { _ = os.Remove(pendingPath(dir)) }

type signedIn struct{ secret string }

const loginExpired = "the sign-in code expired: run kantel login again for a new one"

func startLogin(c *cli.Context, client *api.Client, url, name string, personal bool) (*pendingLogin, error) {
	body := api.StartDeviceLoginBody{ClientName: &name}
	if personal {
		body.Personal = api.Ptr(true)
	}
	asked := personal
	started, err := client.StartDeviceLogin(c.Ctx, body)
	var apiErr *api.Error
	if err != nil && personal && errors.As(err, &apiErr) && apiErr.Code == "invalid" {
		// A Kantel from before personal tokens refuses the field: it signs in with an API key, as it always has.
		started, err = client.StartDeviceLogin(c.Ctx, api.StartDeviceLoginBody{ClientName: &name})
		asked = false
	}
	if err != nil {
		return nil, err
	}
	requested := "key"
	if personal {
		requested = "personal"
	}
	p := pendingLogin{URL: url, DeviceCode: started.DeviceCode, UserCode: started.UserCode,
		VerificationURL: started.VerificationURL, VerificationURLComplete: started.VerificationURLComplete,
		IntervalSeconds: started.IntervalSeconds, ExpiresAt: started.ExpiresAt, Personal: asked, Requested: requested}
	return &p, keepPending(c.IO.ConfigDir, p)
}

func waitForLogin(c *cli.Context, client *api.Client, p *pendingLogin) (*signedIn, error) {
	interval := time.Duration(max(1, p.IntervalSeconds)) * time.Second
	finish := func(msg string) (*signedIn, error) {
		forgetPending(c.IO.ConfigDir)
		return nil, cli.Fail(msg)
	}
	for {
		result, err := client.PollDeviceLogin(c.Ctx, api.PollDeviceLoginBody{DeviceCode: p.DeviceCode})
		var apiErr *api.Error
		if errors.As(err, &apiErr) && apiErr.Code == "not_found" {
			// Kantel no longer knows the code, as it expired and was cleared.
			return finish(loginExpired)
		}
		if err != nil {
			return nil, err
		}
		switch {
		case result.State == api.DeviceLoginStateApproved && result.Token != nil:
			forgetPending(c.IO.ConfigDir)
			return &signedIn{secret: result.Token.Secret}, nil
		case result.State == api.DeviceLoginStateApproved && result.Issued != nil:
			forgetPending(c.IO.ConfigDir)
			return &signedIn{secret: result.Issued.Secret}, nil
		case result.State == api.DeviceLoginStateDenied:
			return finish("the sign-in was denied in the browser")
		case result.State != api.DeviceLoginStatePending || now(c).UnixMilli() >= p.ExpiresAt:
			return finish(loginExpired)
		}
		if err := sleep(c, interval); err != nil {
			return nil, err
		}
	}
}

func sleep(c *cli.Context, d time.Duration) error {
	if c.IO.Sleep != nil {
		return c.IO.Sleep(c.Ctx, d)
	}
	select {
	case <-c.Ctx.Done():
		return c.Ctx.Err()
	case <-time.After(d):
		return nil
	}
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil {
		return "this computer"
	}
	return name
}

// browserLogin signs in in the browser; nil when it stopped to let the person approve it later (no terminal).
func browserLogin(c *cli.Context, url string) (*signedIn, error) {
	client := ClientFor(c, cli.Settings{URL: url})
	personal := !c.Bool("account-key")
	want := "key"
	if personal {
		want = "personal"
	}
	pending := readPending(c.IO.ConfigDir, url, now(c))
	// A code kept for the other kind of sign-in isn't carried on: --account-key never collects a personal token.
	if pending == nil || pending.requested() != want {
		var err error
		if pending, err = startLogin(c, client, url, c.StrOr("name", "kantel on "+hostname()), personal); err != nil {
			return nil, err
		}
	}
	interactive := c.IO.StdoutTTY && !c.JSON
	waiting := interactive || c.Bool("wait")
	if c.JSON {
		// With --json, stdout holds one document: this when it stops here, else the signed-in caller.
		line, _ := json.Marshal(map[string]any{"event": "login_pending", "url": pending.VerificationURLComplete,
			"code": pending.UserCode, "expiresAt": pending.ExpiresAt})
		if waiting {
			c.Note(string(line))
		} else {
			c.Out(string(line))
		}
	} else {
		say := c.Note
		if interactive {
			say = c.Out
		}
		say("Open this page and check the code matches: " + c.Style.Paint(cli.Bold, pending.UserCode))
		say("  " + pending.VerificationURLComplete)
	}
	if !waiting {
		if !c.JSON {
			// The same --url, or --wait would sign in to the saved or default URL, where this code isn't known.
			line := "Then run: kantel login --wait"
			if !personal {
				line += " --account-key"
			}
			if _, ok := c.Str("url"); ok {
				line += " --url " + cli.Origin(url)
			}
			c.Note(line)
		}
		return nil, nil
	}
	if interactive && !c.Bool("no-browser") && c.IO.Env.Get("KANTEL_NO_BROWSER") == "" && c.IO.OpenURL != nil {
		c.IO.OpenURL(pending.VerificationURLComplete)
	}
	var result *signedIn
	err := c.Spin("Waiting for you to approve it in the browser…", func() error {
		var err error
		result, err = waitForLogin(c, client, pending)
		return err
	})
	return result, err
}

// callerName is who the caller is: `Ada <ada@example.com>`, or the key it signs in with.
func callerName(caller api.Caller) string {
	switch {
	case caller.User != nil && caller.User.Email != nil:
		return caller.User.Name + " <" + *caller.User.Email + ">"
	case caller.User != nil:
		return caller.User.Name
	case caller.APIKey != nil:
		return "the key " + caller.APIKey.Name + " (" + caller.APIKey.ID + ")"
	}
	return "an unknown caller"
}

// credentialLine is how the caller signed in, for login: `, with a personal token for all your accounts`.
func credentialLine(caller api.Caller) string {
	if t := caller.PersonalToken; t != nil {
		where := "all your accounts"
		if len(t.Accounts) > 0 {
			where = strings.Join(t.Accounts, ", ")
		}
		return fmt.Sprintf(", with the personal token %s for %s, until %s", t.Name, where, cli.Timestamp(t.ExpiresAt))
	}
	if caller.APIKey != nil {
		return ", with the API key " + caller.APIKey.Name + " for " + caller.AccountID + " only"
	}
	return ""
}

// revokeOwnToken revokes the personal token s signs in with, as logout and a new login do; answers whether it did.
func revokeOwnToken(c *cli.Context, s cli.Settings) bool {
	client := ClientFor(c, s)
	caller, err := client.GetCaller(c.Ctx)
	if err != nil || caller.PersonalToken == nil {
		return false
	}
	_, err = client.RevokePersonalToken(c.Ctx, caller.PersonalToken.ID)
	return err == nil
}

func signingIn() cli.Section {
	return cli.Section{Title: "Signing in", Commands: []*cli.Command{
		{
			Name:    "login",
			Summary: "Sign in in the browser, or with a token or API key, and save it for the commands after",
			Flags: []cli.Flag{
				{Name: "key-stdin", Type: cli.Bool, Description: "Read a personal access token or API key from stdin rather than signing in in the browser"},
				{Name: "account-key", Type: cli.Bool, Description: "Ask for an API key in one account (picked in the browser) rather than a personal token"},
				{Name: "no-browser", Type: cli.Bool, Description: "Print the sign-in URL but don't open it"},
				{Name: "wait", Type: cli.Bool, Description: "Wait for the browser sign-in even with no terminal (agents, scripts)"},
				{Name: "name", Type: cli.String, Value: "<name>", Description: "The new token's name (default kantel on <host>)"},
			},
			Details: "With no key it prints a code and opens Kantel's console, where you approve it; the CLI gets a personal\n" +
				"access token of its own (90 days), which acts as you in every account you belong to: --account, or\n" +
				"kantel org use, picks the one a command acts in. You can revoke it with kantel token revoke, or under\n" +
				"Profile in the console. --account-key asks for an API key in one account instead, which needs admin there.\n" +
				"With no terminal it prints the URL and code and exits; run kantel login --wait to wait for the approval.\n" +
				"Running it again shows the same code.\n" +
				"It signs in to " + cli.DefaultURL + " unless you give --url (or KANTEL_URL), for a self-hosted Kantel.\n\n" +
				"An existing key comes from --key-stdin, which keeps it out of your shell history and process list:\n" +
				"  printf %s \"$KANTEL_API_KEY\" | kantel login --key-stdin --url https://kantel.example\n" +
				"It is saved, readable by you only, in ~/.config/kantel/config.json (or under XDG_CONFIG_HOME).",
			Examples: []cli.Example{
				{What: "Sign in in the browser, to the hosted Kantel", Line: "kantel login"},
				{What: "Sign in to your own Kantel", Line: "kantel login --url https://kantel.example.com"},
				{What: "Save a token or key you have, kept out of your shell history", Line: `printf %s "$KANTEL_API_KEY" | kantel login --key-stdin`},
			},
			Run: runLogin,
		},
		{
			Name:    "logout",
			Summary: "Forget the saved token or API key, revoking a personal token",
			Run: func(c *cli.Context) error {
				stored, err := cli.ReadStored(c.IO.ConfigDir)
				if err != nil {
					return err
				}
				path := filepath.Join(c.IO.ConfigDir, "config.json")
				// A personal token is the CLI's own: signing out revokes it, so a copy of the file is no use.
				revoked := strings.HasPrefix(stored.APIKey, "kpt_") && stored.URL != "" &&
					revokeOwnToken(c, cli.Settings{URL: stored.URL, APIKey: stored.APIKey})
				if stored.APIKey != "" {
					if _, err := cli.WriteStored(c.IO.ConfigDir, cli.Stored{URL: stored.URL, Account: stored.Account}); err != nil {
						return err
					}
				}
				if c.IO.Env.Get("KANTEL_API_KEY") != "" {
					c.Note("kantel: KANTEL_API_KEY is still set in your environment.")
				}
				c.Emit(nil, map[string]any{"signedOut": stored.APIKey != "", "revoked": revoked, "path": path}, func() string {
					switch {
					case stored.APIKey == "":
						return "No key was saved."
					case revoked:
						return "Revoked the saved personal token and removed it from " + path + "."
					}
					return "Removed the saved key from " + path + "."
				})
				return nil
			},
		},
		{
			Name:    "whoami",
			Summary: "Who you are signed in as, and the accounts you may act in",
			Run: func(c *cli.Context) error {
				s, err := Settings(c)
				if err != nil {
					return err
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				caller, err := client.GetCaller(c.Ctx, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, caller, func() string {
					var accounts []string
					for _, a := range caller.Accounts {
						name := a.Name
						if a.Kind == api.AccountKindPersonal {
							name = "personal"
						}
						accounts = append(accounts, fmt.Sprintf("%s (%s, %s)", a.ID, name, a.Role))
					}
					user, key, token, super := "", "", "", ""
					if caller.User != nil {
						user = callerName(*caller)
					}
					if k := caller.APIKey; k != nil {
						key = fmt.Sprintf("%s (%s): %s", k.Name, k.ID, joinScopes(k.Scopes))
					}
					if t := caller.PersonalToken; t != nil {
						scopes := "as your role allows"
						if len(t.Scopes) > 0 {
							scopes = joinScopes(t.Scopes)
						}
						in := ""
						if len(t.Accounts) > 0 {
							in = ", in " + strings.Join(t.Accounts, ", ") + " only"
						}
						token = fmt.Sprintf("%s (%s), personal: %s%s, until %s", t.Name, t.ID, scopes, in, cli.Timestamp(t.ExpiresAt))
					}
					if caller.SuperAdmin {
						super = "yes"
					}
					account := s.Account
					if account == "" {
						account = caller.AccountID
					}
					return cli.Fields(c.Style, []cli.Field{
						{"url", cli.Origin(s.URL)}, {"user", user}, {"key", key}, {"token", token},
						{"account", account}, {"accounts", strings.Join(accounts, ", ")},
						{"mode", string(caller.Mode)}, {"super-admin", super},
					})
				})
				return nil
			},
		},
	}}
}

func joinScopes(scopes []api.APIKeyScope) string {
	out := make([]string, len(scopes))
	for i, s := range scopes {
		out[i] = string(s)
	}
	return strings.Join(out, ", ")
}

func runLogin(c *cli.Context) error {
	stored, err := cli.ReadStored(c.IO.ConfigDir)
	if err != nil {
		return err
	}
	key, _ := c.Str("key")
	if key == "" {
		key, _ = c.Str("api-key")
	}
	if key == "" && c.Bool("key-stdin") {
		raw, err := io.ReadAll(c.IO.Stdin)
		if err != nil {
			return err
		}
		if key = strings.TrimSpace(string(raw)); key == "" {
			return cli.Usage("there was no key on stdin")
		}
	}
	flagURL, _ := c.Str("url")
	flagAccount, _ := c.Str("account")
	if key == "" {
		s, err := cli.Resolve(cli.Settings{URL: flagURL}, c.IO.Env, stored, cli.DefaultURL)
		if err != nil {
			return err
		}
		signed, err := browserLogin(c, s.URL)
		if err != nil || signed == nil {
			return err
		}
		key = signed.secret
	}
	s, err := cli.Resolve(cli.Settings{URL: flagURL, APIKey: key, Account: flagAccount}, c.IO.Env, stored, cli.DefaultURL)
	if err != nil {
		return err
	}
	var raw json.RawMessage
	caller, err := ClientFor(c, s).GetCaller(c.Ctx, api.Raw(&raw))
	if err != nil {
		return err
	}
	sameServer := false
	if stored.URL != "" {
		if u, err := cli.NormaliseURL(stored.URL); err == nil && u == s.URL {
			sameServer = true
		}
	}
	account := flagAccount
	if account == "" && sameServer {
		account = stored.Account
	}
	path, err := cli.WriteStored(c.IO.ConfigDir, cli.Stored{URL: s.URL, APIKey: key, Account: account})
	if err != nil {
		return err
	}
	if env := c.IO.Env.Get("KANTEL_API_KEY"); env != "" && env != key {
		c.Note("kantel: KANTEL_API_KEY is set in your environment, and comes before the saved key.")
	}
	// Signing in again replaces the saved token: the one it replaces is revoked, so it doesn't linger. It goes to the
	// server it was saved for, never the new one, wherever this sign-in is.
	if stored.APIKey != "" && stored.APIKey != key && strings.HasPrefix(stored.APIKey, "kpt_") && stored.URL != "" {
		revokeOwnToken(c, cli.Settings{URL: stored.URL, APIKey: stored.APIKey})
	}
	acting := account
	if acting == "" {
		acting = caller.AccountID
	}
	actingLabel := acting
	for _, a := range caller.Accounts {
		if a.ID == acting {
			actingLabel = accountLabel(a)
		}
	}
	c.Emit(raw, caller, func() string {
		tick := ""
		if c.Style.On {
			tick = c.Style.Paint(cli.Green, "✓") + " "
		}
		picks := ""
		if caller.PersonalToken != nil && len(caller.Accounts) > 1 {
			picks = ": kantel org use picks another, or --account for one command"
		}
		return strings.Join([]string{
			fmt.Sprintf("%sSigned in to %s as %s%s.", tick, cli.Origin(s.URL), callerName(*caller), credentialLine(*caller)),
			fmt.Sprintf("Commands act in %s%s.", actingLabel, picks),
			c.Style.Paint(cli.Dim, "Saved to "+path+"."),
		}, "\n")
	})
	return nil
}
