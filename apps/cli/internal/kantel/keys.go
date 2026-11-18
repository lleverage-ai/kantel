package kantel

import (
	"encoding/json"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// Presets are the named sets of scopes a key or token may have.
var Presets = []string{"agent", "ci", "read-only", "admin"}

// Scopes are what a key may do.
var Scopes = []string{
	"sandboxes:read", "sandboxes:write", "sandboxes:delete", "exec", "files", "access",
	"snapshots:read", "snapshots:write", "account:read", "account:admin", "hosts:admin",
}

// choiceOf is a flag's value if it is one of allowed (a usage error else), nil when it wasn't given.
func choiceOf(c *cli.Context, flag string, allowed []string) (*string, error) {
	value, ok := c.Str(flag)
	if !ok {
		return nil, nil
	}
	if _, err := Choice(value, "--"+flag, allowed...); err != nil {
		return nil, err
	}
	return &value, nil
}

// choicesOf is a repeated flag's values, each one of allowed; nil when none were given.
func choicesOf(c *cli.Context, flag string, allowed []string) ([]string, error) {
	values := c.List(flag)
	if len(values) == 0 {
		return nil, nil
	}
	for _, v := range values {
		if _, err := Choice(v, "--"+flag, allowed...); err != nil {
			return nil, err
		}
	}
	return values, nil
}

func asScopes(values []string) []api.APIKeyScope {
	if values == nil {
		return nil
	}
	out := make([]api.APIKeyScope, len(values))
	for i, v := range values {
		out[i] = api.APIKeyScope(v)
	}
	return out
}

func asPreset(value *string) *api.APIKeyPreset {
	if value == nil {
		return nil
	}
	p := api.APIKeyPreset(*value)
	return &p
}

func scopeTexts(scopes []api.APIKeyScope) []string {
	out := make([]string, len(scopes))
	for i, s := range scopes {
		out[i] = string(s)
	}
	return out
}

func keyState(c *cli.Context, key api.APIKey) string {
	if key.RevokedAt != nil {
		return "revoked"
	}
	if key.ExpiresAt != nil {
		if *key.ExpiresAt <= now(c).UnixMilli() {
			return "expired"
		}
		return "expires " + cli.Until(*key.ExpiresAt, now(c))
	}
	return "active"
}

func issuedKey(issued api.IssuedAPIKey) string {
	return strings.Join([]string{
		issued.Key.ID + " (" + issued.Key.Name + "): " + strings.Join(scopeTexts(issued.Key.Scopes), ", "),
		"",
		"  " + issued.Secret,
		"",
		"Store it now: it isn't shown again.",
	}, "\n")
}

var (
	presetFlag = cli.Flag{Name: "preset", Type: cli.String, Value: "<agent|ci|read-only|admin>", Choices: Presets}
	scopeFlag  = cli.Flag{Name: "scope", Type: cli.String, Multiple: true, Value: "<scope>", Choices: Scopes}
)

// keys is the "API keys and personal tokens" section.
func keys() cli.Section {
	keyPreset, keyScope := presetFlag, scopeFlag
	keyPreset.Description = "A named set of scopes"
	keyScope.Description = "A scope; repeat for more"
	tokenPreset, tokenScope := presetFlag, scopeFlag
	tokenPreset.Description = "Cap it at a set of scopes"
	tokenScope.Description = "Cap it at a scope; repeat for more"
	var tokenScopes []string
	for _, s := range Scopes {
		if s != "hosts:admin" {
			tokenScopes = append(tokenScopes, s)
		}
	}
	return cli.Section{Title: "API keys and personal tokens", Commands: []*cli.Command{
		{
			Name: "key list", Summary: "The account's API keys",
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
				list, err := client.ListAPIKeys(c.Ctx, &api.ListAPIKeysQuery{Account: account}, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, list, func() string {
					if len(list.Items) == 0 {
						return "No API keys."
					}
					var rows [][]string
					for _, k := range list.Items {
						rows = append(rows, []string{k.ID, k.Name, k.Prefix, keyState(c, k), strings.Join(scopeTexts(k.Scopes), ",")})
					}
					return cli.Table(c.Style, []string{"ID", "NAME", "PREFIX", "STATE", "SCOPES"}, rows)
				})
				return nil
			},
		},
		{
			Name: "key create", Summary: "Make a scoped API key; its secret is shown once",
			Args: []cli.Arg{{Name: "name"}},
			Flags: []cli.Flag{
				keyPreset,
				keyScope,
				{Name: "expires-days", Type: cli.String, Value: "<n>", Description: "It stops working after this many days"},
				{Name: "sandbox", Type: cli.String, Multiple: true, Value: "<id>", Description: "Limit it to this sandbox"},
			},
			Details: "Scopes: " + strings.Join(Scopes, ", ") + ".\nA coding agent's key: kantel key create agent --preset agent",
			Examples: []cli.Example{
				{What: "A key for a coding agent: it makes and drives sandboxes, but can't delete them", Line: "kantel key create agent --preset agent"},
				{What: "A CI key that lasts 90 days", Line: "kantel key create ci --preset ci --expires-days 90"},
			},
			Run: func(c *cli.Context) error {
				preset, err := choiceOf(c, "preset", Presets)
				if err != nil {
					return err
				}
				scopes, err := choicesOf(c, "scope", Scopes)
				if err != nil {
					return err
				}
				days, err := Whole(c, "expires-days", 1)
				if err != nil {
					return err
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := AccountPtr(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				issued, err := client.CreateAPIKey(c.Ctx, api.CreateAPIKeyBody{
					Account: account, Name: c.Arg(0), Preset: asPreset(preset), Scopes: asScopes(scopes),
					ExpiresInDays: days, SandboxIds: c.List("sandbox"),
				}, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, issued, func() string { return issuedKey(*issued) })
				return nil
			},
		},
		{
			Name: "key rotate", Summary: "Replace a key's secret; the old one stops working at once", Args: IDArg,
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				issued, err := client.RotateAPIKey(c.Ctx, c.Arg(0), api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, issued, func() string { return issuedKey(*issued) })
				return nil
			},
		},
		{
			Name: "key revoke", Summary: "Stop a key working", Args: IDArg,
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				key, err := client.RevokeAPIKey(c.Ctx, c.Arg(0), api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, key, func() string { return "Revoked " + key.ID + " (" + key.Name + ")." })
				return nil
			},
		},
		{
			Name: "token list", Summary: "Your personal access tokens, in every account",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				list, err := client.ListPersonalTokens(c.Ctx, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, list, func() string {
					if len(list.Items) == 0 {
						return "No personal tokens."
					}
					var rows [][]string
					for _, t := range list.Items {
						state := "active"
						switch {
						case t.RevokedAt != nil:
							state = "revoked"
						case t.ExpiresAt <= now(c).UnixMilli():
							state = "expired"
						}
						scopes := "as your role allows"
						if t.Scopes != nil {
							scopes = strings.Join(scopeTexts(t.Scopes), ", ")
						}
						accounts := "all"
						if t.Accounts != nil {
							accounts = strings.Join(t.Accounts, ", ")
						}
						lastUsed := "never"
						if t.LastUsedAt != nil {
							lastUsed = cli.Ago(*t.LastUsedAt, now(c))
						}
						rows = append(rows, []string{t.ID, t.Name, state, scopes, accounts, cli.Timestamp(t.ExpiresAt), lastUsed})
					}
					return cli.Table(c.Style, []string{"ID", "NAME", "STATE", "SCOPES", "ACCOUNTS", "EXPIRES", "LAST USED"}, rows)
				})
				return nil
			},
		},
		{
			Name: "token create", Summary: "Make a personal access token for a script; its secret is shown once",
			Args: []cli.Arg{{Name: "name"}},
			Flags: []cli.Flag{
				tokenPreset,
				tokenScope,
				{Name: "only", Type: cli.String, Multiple: true, Value: "<account>", Description: "Only this account, by ID or name; repeat for more (default all yours)"},
				{Name: "expires-days", Type: cli.String, Value: "<n>", Description: "It stops working after this many days (90)"},
			},
			Details: "A personal token acts as you, in every account you belong to (or the --only ones), with your role there.\n" +
				"--preset and --scope cap what it may do beyond that. It lasts 90 days unless --expires-days says, at most\n" +
				"366. For an agent or CI that works in one account, an API key (kantel key create) is usually better: it\n" +
				"acts only there, with only its scopes.\nScopes: " + strings.Join(tokenScopes, ", ") + ".",
			Run: func(c *cli.Context) error {
				preset, err := choiceOf(c, "preset", Presets)
				if err != nil {
					return err
				}
				scopes, err := choicesOf(c, "scope", Scopes)
				if err != nil {
					return err
				}
				days, err := Whole(c, "expires-days", 1)
				if err != nil {
					return err
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var only []string
				for _, ref := range c.List("only") {
					a, _, err := accountRef(c, client, ref)
					if err != nil {
						return err
					}
					only = append(only, a.ID)
				}
				var raw json.RawMessage
				issued, err := client.CreatePersonalToken(c.Ctx, api.CreatePersonalTokenBody{
					Name: c.Arg(0), Preset: asPreset(preset), Scopes: asScopes(scopes), Accounts: only, ExpiresInDays: days,
				}, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, issued, func() string {
					return strings.Join([]string{
						issued.Token.ID + " (" + issued.Token.Name + "), until " + cli.Timestamp(issued.Token.ExpiresAt),
						"",
						"  " + issued.Secret,
						"",
						"Store it now: it isn't shown again. Give it to a script as KANTEL_API_KEY.",
					}, "\n")
				})
				return nil
			},
		},
		{
			Name: "token revoke", Summary: "Stop one of your personal tokens working", Args: IDArg,
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				token, err := client.RevokePersonalToken(c.Ctx, c.Arg(0), api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, token, func() string { return "Revoked " + token.ID + " (" + token.Name + ")." })
				return nil
			},
		},
	}}
}
