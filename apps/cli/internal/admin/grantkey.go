package admin

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// The grant key: the Ed25519 key the control plane signs hosts' fetch grants with, for host-to-host sync.

// grantKeysWords is the grant keys as they read: the key that signs, the one a rotation made, then each retired one hosts
// still accept.
func grantKeysWords(c *cli.Context, keys api.GrantKeys) string {
	lines := []string{fmt.Sprintf("Signing with %s (%s), since %s", keys.Current.ID, keys.Current.PublicKey,
		cli.Timestamp(keys.Current.Since))}
	if n := keys.Next; n != nil {
		lines = append(lines, fmt.Sprintf("Signing with %s (%s) from %s, %s: hosts accept it already", n.ID, n.PublicKey,
			cli.Timestamp(n.From), cli.Until(n.From, c.IO.Now())))
	}
	for _, k := range keys.Retired {
		lines = append(lines, fmt.Sprintf("Still accepting %s (%s) until %s, %s", k.ID, k.PublicKey, cli.Timestamp(k.Until),
			cli.Until(k.Until, c.IO.Now())))
	}
	return strings.Join(lines, "\n")
}

// grantKeyCall runs a call that answers the grant keys, and prints them.
func grantKeyCall(c *cli.Context, call func(client *api.Client, raw *json.RawMessage) (*api.GrantKeys, error)) error {
	client, err := Client(c)
	if err != nil {
		return err
	}
	var raw json.RawMessage
	keys, err := call(client, &raw)
	if err != nil {
		return err
	}
	c.Emit(raw, keys, func() string { return grantKeysWords(c, *keys) })
	return nil
}

func grantKey() cli.Section {
	return cli.Section{Title: "Grant key", Commands: []*cli.Command{
		{
			Name:    "grant-key show",
			Summary: "The key the control plane signs hosts' fetch grants with, and the other keys hosts accept",
			Details: "Only public keys: the private key is kept sealed with KANTEL_SECRETS_KEY and never shown.",
			Run: func(c *cli.Context) error {
				return grantKeyCall(c, func(client *api.Client, raw *json.RawMessage) (*api.GrantKeys, error) {
					return client.GetGrantKeys(c.Ctx, api.Raw(raw))
				})
			},
		},
		{
			Name:    "grant-key rotate",
			Summary: "Make a new grant key, and send it to the connected hosts",
			Details: "Connected hosts are sent the new key at once, and it signs grants from 3 minutes on, once they all have\n" +
				"it. Hosts accept the old one for 16 minutes after that (a grant's lifetime and a minute), so fetches\n" +
				"under way finish. A host on a kantel-host from before rotation holds one key: it takes the new one\n" +
				"when it begins signing, and asks again for a grant the old key signed.",
			Run: func(c *cli.Context) error {
				return grantKeyCall(c, func(client *api.Client, raw *json.RawMessage) (*api.GrantKeys, error) {
					return client.RotateGrantKey(c.Ctx, api.Raw(raw))
				})
			},
		},
	}}
}
