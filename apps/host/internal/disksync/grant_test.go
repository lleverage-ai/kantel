package disksync

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A grant packages/compute/src/grants.ts signed (createGrantKey, then sign), valid until 2100: the two sides agree on
// the format. The first is from before key IDs; the second names its key (kid), whose ID is tsKidKeyID.
const (
	tsGrantKey = "RrotbgwdlqnxvSgIpNfhGW-LLzGCmq5mnidVBA8S79k"
	tsGrant    = "eyJraW5kIjoic3RpY2t5Iiwib2JqZWN0SWQiOiJzZGtfMSIsInZlcnNpb24iOiJzZHZfMiIsImFjY291bnRJZCI6ImFjY18xIiwiZnJvbSI6WyJob3N0X2EiLCJob3N0X2MiXSwidG8iOiJob3N0X2IiLCJleHAiOjQxMDI0NDQ4MDAwMDB9.w09tUv8oAKIEJ1F6Vbdkrhoatu5jCjuYATUTFqahQ4_Ufj8Cvr9aEYCayS0BBqKHR654HT6I45xdgPw60ckXAQ"

	tsKidKeyID = "naYsa7rnz7HL"
	tsKidKey   = "8Ecg4AJ1xLsDveMn-92nbVK0ETaMtuO5iQxqzdEoYMU"
	tsKidGrant = "eyJraW5kIjoic3RpY2t5Iiwib2JqZWN0SWQiOiJzZGtfMSIsInZlcnNpb24iOiJzZHZfMiIsImFjY291bnRJZCI6ImFjY18xIiwiZnJvbSI6WyJob3N0X2EiLCJob3N0X2MiXSwidG8iOiJob3N0X2IiLCJleHAiOjQxMDI0NDQ4MDAwMDAsImtpZCI6Im5hWXNhN3JuejdITCJ9.3z5IEpMx-JJ03OF_JgvMmAXAOdPrj_oQkceSq2HtG41Nud0a1gi1q1MPDM2m6BRjgO0WmL41vaU470V72EjfCQ"
)

// one is a single key with no ID, as a welcome from a control plane from before rotation gives it.
func one(publicKey string) []proto.GrantKey { return []proto.GrantKey{{PublicKey: publicKey}} }

// testKey is a grant key for tests: its public key as a welcome carries it, and a signer.
type testKey struct {
	public  string
	private ed25519.PrivateKey
}

func newTestKey(t *testing.T) testKey {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return testKey{public: base64.RawURLEncoding.EncodeToString(pub), private: priv}
}

func (k testKey) sign(t *testing.T, g Grant) string {
	t.Helper()
	raw, err := json.Marshal(g)
	if err != nil {
		t.Fatal(err)
	}
	payload := base64.RawURLEncoding.EncodeToString(raw)
	return payload + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(k.private, []byte(payload)))
}

func TestVerifyGrantReadsTheControlPlanesGrants(t *testing.T) {
	g, err := VerifyGrant(one(tsGrantKey), tsGrant, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if g.Kind != "sticky" || g.ObjectID != "sdk_1" || g.Version != "sdv_2" || g.AccountID != "acc_1" || g.To != "host_b" ||
		len(g.From) != 2 || g.From[1] != "host_c" || g.Exp != 4102444800000 {
		t.Fatalf("grant: %+v", g)
	}
	if err := g.Allows("sticky", "sdk_1", "sdv_2", "host_c", "host_b"); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyGrantRefusesWhatTheKeyDidntSignOrHasExpired(t *testing.T) {
	key, other := newTestKey(t), newTestKey(t)
	now := time.Now()
	good := Grant{Kind: "sticky", ObjectID: "sdk_1", Version: "sdv_1", AccountID: "acc_1", From: []string{"host_a"}, To: "host_b", Exp: now.Add(time.Minute).UnixMilli()}
	if _, err := VerifyGrant(one(key.public), key.sign(t, good), now); err != nil {
		t.Fatalf("a good grant: %v", err)
	}
	expired := good
	expired.Exp = now.UnixMilli()
	payload, sig, _ := strings.Cut(key.sign(t, good), ".")
	otherPayload, _, _ := strings.Cut(key.sign(t, Grant{Kind: "sticky", ObjectID: "sdk_1", Version: "sdv_1", From: []string{"host_a"}, To: "host_c", Exp: good.Exp}), ".")
	for name, token := range map[string]string{
		"another key's":           other.sign(t, good),
		"expired":                 key.sign(t, expired),
		"payload changed":         otherPayload + "." + sig,
		"no signature":            payload,
		"three parts":             payload + "." + sig + "." + sig,
		"not base64":              payload + ".!!",
		"empty":                   "",
		"not a grant":             key.sign(t, Grant{Exp: good.Exp}),
		"the TS grant, other key": tsGrant,
	} {
		if _, err := VerifyGrant(one(key.public), token, now); !errors.Is(err, ErrBadGrant) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := VerifyGrant(one(""), key.sign(t, good), now); err == nil {
		t.Error("verified without a key")
	}
	if _, err := VerifyGrant(nil, key.sign(t, good), now); err == nil {
		t.Error("verified with no keys")
	}
}

// While the grant key is rotated a host holds several: a grant is checked with the key its kid names (or, from before
// key IDs, with any), and a rotated-out key only until its time is up.
func TestVerifyGrantChecksTheKeyItsKidNames(t *testing.T) {
	now := time.Now()
	g, err := VerifyGrant([]proto.GrantKey{{ID: "other", PublicKey: tsGrantKey}, {ID: tsKidKeyID, PublicKey: tsKidKey}}, tsKidGrant, now)
	if err != nil || g.Kid != tsKidKeyID || g.To != "host_b" {
		t.Fatalf("the TS grant with its kid: %+v %v", g, err)
	}
	current, old := newTestKey(t), newTestKey(t)
	keys := []proto.GrantKey{
		{ID: "k2", PublicKey: current.public},
		{ID: "k1", PublicKey: old.public, Until: now.Add(time.Minute).UnixMilli()},
	}
	grant := Grant{Kind: "sticky", ObjectID: "sdk_1", Version: "sdv_1", From: []string{"host_a"}, To: "host_b", Exp: now.Add(time.Hour).UnixMilli()}
	signed := func(k testKey, kid string) string {
		g := grant
		g.Kid = kid
		return k.sign(t, g)
	}
	for name, token := range map[string]string{
		"the current key's":                  signed(current, "k2"),
		"the old key's, within its time":     signed(old, "k1"),
		"from before key IDs, the old key's": signed(old, ""),
	} {
		if _, err := VerifyGrant(keys, token, now); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	for name, token := range map[string]string{
		"the old key's under the current key's ID": signed(old, "k2"),
		"a key not given":                          signed(old, "k0"),
	} {
		if _, err := VerifyGrant(keys, token, now); !errors.Is(err, ErrBadGrant) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := VerifyGrant(keys, signed(old, "k1"), now.Add(time.Minute)); !errors.Is(err, ErrBadGrant) {
		t.Errorf("the old key's past its time: %v", err)
	}
	// A key with no ID (a control plane's from before rotation) is tried whatever kid a grant names.
	if _, err := VerifyGrant(one(current.public), signed(current, "k2"), now); err != nil {
		t.Errorf("a kid with a key of no ID: %v", err)
	}
}

func TestGrantAllowsOnlyItsVersionHoldersAndAsker(t *testing.T) {
	g := Grant{Kind: "sticky", ObjectID: "sdk_1", Version: "sdv_1", From: []string{"host_a", "host_c"}, To: "host_b"}
	if err := g.Allows("sticky", "sdk_1", "sdv_1", "host_a", "host_b"); err != nil {
		t.Fatal(err)
	}
	for name, args := range map[string][5]string{
		"another version":       {"sticky", "sdk_1", "sdv_2", "host_a", "host_b"},
		"another object":        {"sticky", "sdk_2", "sdv_1", "host_a", "host_b"},
		"another kind":          {"template", "sdk_1", "sdv_1", "host_a", "host_b"},
		"another holder":        {"sticky", "sdk_1", "sdv_1", "host_d", "host_b"},
		"another asker":         {"sticky", "sdk_1", "sdv_1", "host_a", "host_c"},
		"an unknown asker":      {"sticky", "sdk_1", "sdv_1", "host_a", ""},
		"the holder for itself": {"sticky", "sdk_1", "sdv_1", "host_b", "host_b"},
	} {
		if err := g.Allows(args[0], args[1], args[2], args[3], args[4]); err == nil {
			t.Errorf("%s: allowed", name)
		}
	}
}
