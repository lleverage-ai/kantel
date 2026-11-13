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
)

// A grant packages/compute/src/grants.ts signed (createGrantKey, then sign), valid until 2100: the two sides agree on
// the format.
const (
	tsGrantKey = "RrotbgwdlqnxvSgIpNfhGW-LLzGCmq5mnidVBA8S79k"
	tsGrant    = "eyJraW5kIjoic3RpY2t5Iiwib2JqZWN0SWQiOiJzZGtfMSIsInZlcnNpb24iOiJzZHZfMiIsImFjY291bnRJZCI6ImFjY18xIiwiZnJvbSI6WyJob3N0X2EiLCJob3N0X2MiXSwidG8iOiJob3N0X2IiLCJleHAiOjQxMDI0NDQ4MDAwMDB9.w09tUv8oAKIEJ1F6Vbdkrhoatu5jCjuYATUTFqahQ4_Ufj8Cvr9aEYCayS0BBqKHR654HT6I45xdgPw60ckXAQ"
)

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
	g, err := VerifyGrant(tsGrantKey, tsGrant, time.Now())
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
	if _, err := VerifyGrant(key.public, key.sign(t, good), now); err != nil {
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
		if _, err := VerifyGrant(key.public, token, now); !errors.Is(err, ErrBadGrant) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := VerifyGrant("", key.sign(t, good), now); err == nil {
		t.Error("verified without a key")
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
