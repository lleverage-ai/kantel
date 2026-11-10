package kantel

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// Visibilities are who sees an account's new sandboxes by default.
var Visibilities = []string{"organisation", "private"}

// Roles are a member's roles.
var Roles = []string{"member", "admin", "owner"}

// accountRef is an account of yours by ID or by name (personal for your personal account), with Kantel's answer for
// it as it was sent.
func accountRef(c *cli.Context, client *api.Client, ref string) (*api.Account, json.RawMessage, error) {
	var raw json.RawMessage
	if isAccountID(ref) {
		a, err := client.GetAccount(c.Ctx, ref, api.Raw(&raw))
		return a, raw, err
	}
	list, err := client.ListAccounts(c.Ctx, api.Raw(&raw))
	if err != nil {
		return nil, nil, err
	}
	var found []int
	for i, a := range list.Items {
		if sameAccountName(a, ref) {
			found = append(found, i)
		}
	}
	switch len(found) {
	case 0:
		return nil, nil, cli.Fail(fmt.Sprintf(`you have no account called "%s": kantel org list shows them`, ref))
	case 1:
		var answer struct {
			Items []json.RawMessage `json:"items"`
		}
		_ = json.Unmarshal(raw, &answer)
		var item json.RawMessage
		if found[0] < len(answer.Items) {
			item = answer.Items[found[0]]
		}
		return &list.Items[found[0]], item, nil
	}
	ids := make([]string, len(found))
	for i, n := range found {
		ids[i] = list.Items[n].ID
	}
	return nil, nil, cli.Fail(fmt.Sprintf(`more than one account is called "%s": use its ID (%s)`, ref, strings.Join(ids, ", ")))
}

// currentAccountID is the account commands act in: --account, KANTEL_ACCOUNT or org use's, else the caller's default.
func currentAccountID(c *cli.Context, client *api.Client) (string, error) {
	id, err := Account(c)
	if err != nil || id != "" {
		return id, err
	}
	caller, err := client.GetCaller(c.Ctx)
	if err != nil {
		return "", err
	}
	return caller.AccountID, nil
}

// accountIDOf is the account a command names (ref, by ID or name), else the one commands act in.
func accountIDOf(c *cli.Context, client *api.Client, ref string, named bool) (string, error) {
	if !named {
		return currentAccountID(c, client)
	}
	a, _, err := accountRef(c, client, ref)
	if err != nil {
		return "", err
	}
	return a.ID, nil
}

// organisationOf is the organisation commands act in; a usage error naming how to pick one when it is a personal
// account.
func organisationOf(c *cli.Context, client *api.Client) (*api.Account, error) {
	id, err := currentAccountID(c, client)
	if err != nil {
		return nil, err
	}
	account, err := client.GetAccount(c.Ctx, id)
	if err != nil {
		return nil, err
	}
	if account.Kind != api.AccountKindOrganisation {
		return nil, cli.Usage("this acts on an organisation, and commands act in your personal account: pick one with --account <name> or kantel org use <name>")
	}
	return account, nil
}

// memberIDOf is a member's user ID from their ID or email.
func memberIDOf(c *cli.Context, client *api.Client, accountID, ref string) (string, error) {
	if !strings.Contains(ref, "@") {
		return ref, nil
	}
	members, err := client.ListMembers(c.Ctx, accountID)
	if err != nil {
		return "", err
	}
	wanted := strings.ToLower(strings.TrimSpace(ref))
	for _, m := range members.Items {
		if m.Email != nil && strings.ToLower(*m.Email) == wanted {
			return m.UserID, nil
		}
	}
	return "", cli.Fail("no member has the email " + ref + ": kantel member list shows them")
}

// useAccount saves accountID as the account commands act in, as org use does.
func useAccount(c *cli.Context, accountID string) error {
	stored, err := cli.ReadStored(c.IO.ConfigDir)
	if err != nil {
		return err
	}
	_, err = cli.WriteStored(c.IO.ConfigDir, cli.Stored{URL: stored.URL, APIKey: stored.APIKey, Account: accountID})
	return err
}

// forgetAccount forgets a saved account that has gone (left or deleted), so commands act in the default one again.
func forgetAccount(c *cli.Context, accountID string) error {
	stored, err := cli.ReadStored(c.IO.ConfigDir)
	if err != nil {
		return err
	}
	if stored.Account != accountID {
		return nil
	}
	if _, err := cli.WriteStored(c.IO.ConfigDir, cli.Stored{URL: stored.URL, APIKey: stored.APIKey}); err != nil {
		return err
	}
	c.Note("kantel: commands act in your default account again.")
	return nil
}

func describeAccount(c *cli.Context, a api.Account) string {
	shared := "private"
	if a.DefaultVisibility == "organisation" {
		shared = "shared with the organisation"
	}
	tokens := ""
	if a.Kind == api.AccountKindOrganisation {
		tokens = "allowed"
		if a.PersonalTokens != nil {
			tokens = string(*a.PersonalTokens)
		}
	}
	return cli.Fields(c.Style, []cli.Field{
		{"id", a.ID},
		{"name", a.Name},
		{"kind", string(a.Kind)},
		{"your role", string(a.Role)},
		{"new sandboxes", shared},
		{"personal tokens", tokens},
		{"created", cli.Timestamp(a.CreatedAt)},
	})
}

// roleText is `an admin`, or `a member`.
func roleText(role api.MemberRole) string {
	if role == api.MemberRoleAdmin {
		return "an admin"
	}
	return "a " + string(role)
}

func visibilityOf(c *cli.Context) (*api.SandboxVisibility, error) {
	v, err := choiceOf(c, "visibility", Visibilities)
	if v == nil || err != nil {
		return nil, err
	}
	visibility := api.SandboxVisibility(*v)
	return &visibility, nil
}

var useFlag = cli.Flag{Name: "use", Type: cli.Bool, Description: "Act in it from now on, as kantel org use does"}

// accounts is the "Accounts and organisations" section.
func accounts() cli.Section {
	return cli.Section{Title: "Accounts and organisations", Commands: []*cli.Command{
		{
			Name: "org list", Summary: "Your personal account and your organisations; * marks the one commands act in",
			Run: func(c *cli.Context) error {
				// The saved account by its ID or name, as given: one that can't be reached is said so, not an error.
				s, err := Settings(c)
				if err != nil {
					return err
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				list, err := client.ListAccounts(c.Ctx, api.Raw(&raw))
				if err != nil {
					return err
				}
				caller, err := client.GetCaller(c.Ctx)
				if err != nil {
					return err
				}
				named := s.Account
				current := caller.AccountID
				if named != "" {
					current = named
					for _, a := range list.Items {
						if a.ID == named || sameAccountName(a, named) {
							current = a.ID
							break
						}
					}
				}
				c.Emit(raw, list, func() string {
					reached := false
					var rows [][]string
					for _, a := range list.Items {
						mark := ""
						if a.ID == current {
							mark, reached = "*", true
						}
						rows = append(rows, []string{mark, a.ID, string(a.Kind), a.Name, string(a.Role)})
					}
					listed := cli.Table(c.Style, []string{"", "ID", "KIND", "NAME", "ROLE"}, rows)
					if named != "" && !reached {
						return listed + "\n\nkantel acts in " + current + ", which you can't reach: kantel org use picks another."
					}
					return listed
				})
				return nil
			},
		},
		{
			Name: "org use", Summary: "Act in this account from now on, by ID or name (personal for your own)",
			Args:    []cli.Arg{{Name: "account", Optional: true}},
			Flags:   []cli.Flag{{Name: "clear", Type: cli.Bool, Description: "Go back to the default: your personal account"}},
			Details: "It is saved with your sign-in; --account (or KANTEL_ACCOUNT) still picks another for one command.",
			Run: func(c *cli.Context) error {
				stored, err := cli.ReadStored(c.IO.ConfigDir)
				if err != nil {
					return err
				}
				ref, given := c.Optional(0)
				if c.Bool("clear") || !given {
					if !c.Bool("clear") {
						return cli.Usage("name an account (kantel org list shows them), or give --clear")
					}
					if _, err := cli.WriteStored(c.IO.ConfigDir, cli.Stored{URL: stored.URL, APIKey: stored.APIKey}); err != nil {
						return err
					}
					c.Emit(nil, map[string]any{"account": nil}, func() string { return "Commands act in your default account again." })
					return nil
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, raw, err := accountRef(c, client, ref)
				if err != nil {
					return err
				}
				if _, err := cli.WriteStored(c.IO.ConfigDir, cli.Stored{URL: stored.URL, APIKey: stored.APIKey, Account: account.ID}); err != nil {
					return err
				}
				if env := c.IO.Env.Get("KANTEL_ACCOUNT"); env != "" && env != account.ID {
					c.Note("kantel: KANTEL_ACCOUNT is set in your environment, and comes before the saved account.")
				}
				c.Emit(raw, account, func() string { return "Commands act in " + accountLabel(*account) + " from now on." })
				return nil
			},
		},
		{
			Name: "org show", Summary: "An account: its kind, your role, and its settings",
			Args: []cli.Arg{{Name: "account", Optional: true}},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				ref, named := c.Optional(0)
				id, err := accountIDOf(c, client, ref, named)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				account, err := client.GetAccount(c.Ctx, id, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, account, func() string { return describeAccount(c, *account) })
				return nil
			},
		},
		{
			Name: "org create", Summary: "Make an organisation, with you as its owner",
			Args: []cli.Arg{{Name: "name"}},
			Flags: []cli.Flag{
				{Name: "visibility", Type: cli.String, Value: "<organisation|private>", Choices: Visibilities, Description: "Who sees new sandboxes by default (organisation)"},
				useFlag,
			},
			Run: func(c *cli.Context) error {
				visibility, err := visibilityOf(c)
				if err != nil {
					return err
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				account, err := client.CreateOrganisation(c.Ctx, api.CreateOrganisationBody{Name: c.Arg(0), DefaultVisibility: visibility}, api.Raw(&raw))
				if err != nil {
					return err
				}
				use := c.Bool("use")
				if use {
					if err := useAccount(c, account.ID); err != nil {
						return err
					}
				}
				c.Emit(raw, account, func() string {
					next := " Act in it with: kantel org use " + account.ID
					if use {
						next = " Commands act in it from now on."
					}
					return "Created " + account.Name + " (" + account.ID + ")." + next
				})
				return nil
			},
		},
		{
			Name: "org join", Summary: "Join an organisation with an invite's code",
			Args:  []cli.Arg{{Name: "code"}},
			Flags: []cli.Flag{useFlag},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				account, err := client.JoinOrganisation(c.Ctx, api.JoinOrganisationBody{Code: c.Arg(0)}, api.Raw(&raw))
				if err != nil {
					return err
				}
				if c.Bool("use") {
					if err := useAccount(c, account.ID); err != nil {
						return err
					}
				}
				c.Emit(raw, account, func() string {
					return fmt.Sprintf("Joined %s (%s) as %s.", account.Name, account.ID, account.Role)
				})
				return nil
			},
		},
		{
			Name: "org set", Summary: "Change the account's name, default visibility, or whether personal tokens work in it",
			Flags: []cli.Flag{
				{Name: "name", Type: cli.String, Value: "<name>", Description: "Rename it"},
				{Name: "visibility", Type: cli.String, Value: "<organisation|private>", Choices: Visibilities, Description: "Who sees new sandboxes by default"},
				{Name: "personal-tokens", Type: cli.String, Value: "<allowed|blocked>",
					Description: "blocked: members' personal tokens can't act in it (an organisation's)"},
			},
			Details: "It changes the account commands act in (--account or kantel org use); it needs admin or owner.",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				visibility, err := visibilityOf(c)
				if err != nil {
					return err
				}
				tokens, err := choiceOf(c, "personal-tokens", []string{"allowed", "blocked"})
				if err != nil {
					return err
				}
				body := api.UpdateAccountBody{Name: StrPtr(c, "name"), DefaultVisibility: visibility}
				if tokens != nil {
					policy := api.PersonalTokenPolicy(*tokens)
					body.PersonalTokens = &policy
				}
				if body.Name == nil && body.DefaultVisibility == nil && body.PersonalTokens == nil {
					return cli.Usage("say what to change: --name, --visibility or --personal-tokens")
				}
				id, err := currentAccountID(c, client)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				account, err := client.UpdateAccount(c.Ctx, id, body, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, account, func() string { return describeAccount(c, *account) })
				return nil
			},
		},
		{
			Name: "org usage", Summary: "The account's running time and cost, and its limits",
			Flags: []cli.Flag{{Name: "days", Type: cli.String, Value: "<n>", Description: "Over this many days (default 1)"}},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				days, err := Whole(c, "days", 1)
				if err != nil {
					return err
				}
				if days == nil {
					days = api.Ptr(int64(1))
				}
				id, err := currentAccountID(c, client)
				if err != nil {
					return err
				}
				since := now(c).UnixMilli() - *days*24*3_600_000
				var raw json.RawMessage
				usage, err := client.GetAccountUsage(c.Ctx, id, &api.GetAccountUsageQuery{Since: &since}, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, usage, func() string {
					rows := []cli.Field{
						{"account", usage.AccountID},
						{"since", cli.Timestamp(usage.Since)},
						{"running now", strconv.FormatInt(usage.Running, 10)},
						{"running time", cli.Duration(usage.RunningSeconds)},
						{"cost", cli.Money(usage.Cost.Total, usage.Cost.Currency)},
					}
					// The limits as Kantel names them, in its order.
					limits, _ := objectMembers(memberOf(raw, "limits"))
					for _, l := range limits {
						value := string(l.Value)
						var text string
						if json.Unmarshal(l.Value, &text) == nil {
							value = text
						}
						rows = append(rows, cli.Field{"limit " + l.Key, value})
					}
					return cli.Fields(c.Style, rows)
				})
				return nil
			},
		},
		{
			Name: "org leave", Summary: "Leave the organisation (needs --yes)",
			Flags:   []cli.Flag{{Name: "yes", Type: cli.Bool, Short: "y", Description: "Yes, leave it"}},
			Details: "Your private sandboxes there stay, stopped, for its admins. You need an invite to come back.",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := organisationOf(c, client)
				if err != nil {
					return err
				}
				if !c.Bool("yes") {
					return cli.Usage(fmt.Sprintf("to leave %s (%s), run: kantel org leave --account %s --yes", account.Name, account.ID, account.ID))
				}
				caller, err := client.GetCaller(c.Ctx)
				if err != nil {
					return err
				}
				if caller.User == nil || caller.APIKey != nil {
					return cli.Fail("an API key can't leave an organisation: sign in as yourself (kantel login)")
				}
				if err := client.RemoveMember(c.Ctx, account.ID, caller.User.ID); err != nil {
					return err
				}
				if err := forgetAccount(c, account.ID); err != nil {
					return err
				}
				c.Emit(nil, map[string]string{"left": account.ID}, func() string { return "You left " + account.Name + "." })
				return nil
			},
		},
		{
			Name: "org delete", Summary: "Delete the organisation for good (needs --yes; owners only)",
			Flags:   []cli.Flag{{Name: "yes", Type: cli.Bool, Short: "y", Description: "Yes, delete it: this can't be undone"}},
			Details: "It is refused while it has sandboxes or saved snapshots. Its members, invites, API keys and webhooks go too.",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := organisationOf(c, client)
				if err != nil {
					return err
				}
				if !c.Bool("yes") {
					return cli.Usage(fmt.Sprintf("deleting %s (%s) is permanent. To delete it, run: kantel org delete --account %s --yes", account.Name, account.ID, account.ID))
				}
				if err := client.DeleteOrganisation(c.Ctx, account.ID); err != nil {
					return err
				}
				if err := forgetAccount(c, account.ID); err != nil {
					return err
				}
				c.Emit(nil, map[string]string{"deleted": account.ID}, func() string { return "Deleted " + account.Name + "." })
				return nil
			},
		},
		{
			Name: "member list", Summary: "The organisation's members and their roles",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := organisationOf(c, client)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				members, err := client.ListMembers(c.Ctx, account.ID, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, members, func() string {
					var rows [][]string
					for _, m := range members.Items {
						rows = append(rows, []string{m.UserID, m.Name, Deref(m.Email), string(m.Role), cli.Ago(m.JoinedAt, now(c))})
					}
					return cli.Table(c.Style, []string{"USER", "NAME", "EMAIL", "ROLE", "JOINED"}, rows)
				})
				return nil
			},
		},
		{
			Name: "member role", Summary: "Make a member a member, admin or owner",
			Args:    []cli.Arg{{Name: "user"}, {Name: "role"}},
			Details: "<user> is their user ID or email. Changing roles needs admin; making or unmaking an owner, an owner.",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := organisationOf(c, client)
				if err != nil {
					return err
				}
				role, err := Choice(c.Arg(1), "the role", Roles...)
				if err != nil {
					return err
				}
				userID, err := memberIDOf(c, client, account.ID, c.Arg(0))
				if err != nil {
					return err
				}
				var raw json.RawMessage
				member, err := client.UpdateMember(c.Ctx, account.ID, userID, api.UpdateMemberBody{Role: api.MemberRole(role)}, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, member, func() string {
					return member.Name + " is " + roleText(member.Role) + " of " + account.Name + "."
				})
				return nil
			},
		},
		{
			Name: "member rm", Summary: "Remove someone from the organisation",
			Args:    []cli.Arg{{Name: "user"}},
			Details: "<user> is their user ID or email. Their private sandboxes there stay, stopped, for an admin.",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := organisationOf(c, client)
				if err != nil {
					return err
				}
				userID, err := memberIDOf(c, client, account.ID, c.Arg(0))
				if err != nil {
					return err
				}
				if err := client.RemoveMember(c.Ctx, account.ID, userID); err != nil {
					return err
				}
				c.Emit(nil, map[string]string{"removed": userID}, func() string { return "Removed " + c.Arg(0) + " from " + account.Name + "." })
				return nil
			},
		},
		{
			Name: "invite list", Summary: "The organisation's open invites",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := organisationOf(c, client)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				invites, err := client.ListInvites(c.Ctx, account.ID, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, invites, func() string {
					if len(invites.Items) == 0 {
						return "No open invites."
					}
					var rows [][]string
					for _, i := range invites.Items {
						rows = append(rows, []string{i.ID, inviteFor(i), string(i.Role), cli.Until(i.ExpiresAt, now(c))})
					}
					return cli.Table(c.Style, []string{"ID", "FOR", "ROLE", "EXPIRES"}, rows)
				})
				return nil
			},
		},
		{
			Name: "invite create", Summary: "Invite someone to the organisation; its code is shown once",
			Flags: []cli.Flag{
				{Name: "email", Type: cli.String, Value: "<email>", Description: "Only this person may use it, and Kantel emails it"},
				{Name: "role", Type: cli.String, Value: "<member|admin|owner>", Description: "Their role (member)"},
				{Name: "expires-hours", Type: cli.String, Value: "<n>", Description: "It lasts this many hours (168, a week)"},
			},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := organisationOf(c, client)
				if err != nil {
					return err
				}
				role, err := choiceOf(c, "role", Roles)
				if err != nil {
					return err
				}
				hours, err := Whole(c, "expires-hours", 1)
				if err != nil {
					return err
				}
				body := api.CreateInviteBody{Email: StrPtr(c, "email"), ExpiresInHours: hours}
				if role != nil {
					r := api.MemberRole(*role)
					body.Role = &r
				}
				var raw json.RawMessage
				invite, err := client.CreateInvite(c.Ctx, account.ID, body, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, invite, func() string {
					lines := []string{fmt.Sprintf("Invited %s to %s as %s, until %s.", inviteFor(*invite), account.Name,
						roleText(invite.Role), cli.Timestamp(invite.ExpiresAt))}
					if invite.Emailed != nil && *invite.Emailed {
						lines = append(lines, "Kantel emailed them a link to join.")
					}
					return strings.Join(append(lines, "", "  kantel org join "+Deref(invite.Code), "", "The code isn't shown again."), "\n")
				})
				return nil
			},
		},
		{
			Name: "invite revoke", Summary: "Stop an invite working", Args: IDArg,
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := organisationOf(c, client)
				if err != nil {
					return err
				}
				if err := client.RevokeInvite(c.Ctx, account.ID, c.Arg(0)); err != nil {
					return err
				}
				c.Emit(nil, map[string]string{"revoked": c.Arg(0)}, func() string { return "Revoked " + c.Arg(0) + "." })
				return nil
			},
		},
	}}
}

func inviteFor(i api.Invite) string {
	if i.Email != nil {
		return *i.Email
	}
	return "anyone with the code"
}
