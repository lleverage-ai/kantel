package bucket

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// gcsScope is what a service account's token may do: read objects, nothing else.
const gcsScope = "https://www.googleapis.com/auth/devstorage.read_only"

// serviceAccount is a GCS service account's JSON key, as Google gives it: the fields a token needs.
type serviceAccount struct {
	Type         string `json:"type"`
	ClientEmail  string `json:"client_email"`
	PrivateKeyID string `json:"private_key_id"`
	PrivateKey   string `json:"private_key"`
	TokenURI     string `json:"token_uri"`
}

// tokenSource trades a service account's key for OAuth access tokens (a signed JWT, RFC 7523), kept until shortly
// before they expire, for GCS's XML API's Authorization: Bearer.
type tokenSource struct {
	email, keyID, tokenURI string
	key                    *rsa.PrivateKey
	http                   *http.Client
	now                    func() time.Time

	mu      sync.Mutex
	token   string
	expires time.Time
}

func newTokenSource(raw string, httpClient *http.Client, now func() time.Time) (*tokenSource, error) {
	var sa serviceAccount
	if err := json.Unmarshal([]byte(raw), &sa); err != nil {
		return nil, errors.New("the service account key isn't a JSON key")
	}
	if sa.Type != "" && sa.Type != "service_account" {
		return nil, fmt.Errorf("the service account key is a %q key, not a service account's", sa.Type)
	}
	if sa.ClientEmail == "" || sa.PrivateKey == "" {
		return nil, errors.New("the service account key has no client_email or private_key")
	}
	block, _ := pem.Decode([]byte(sa.PrivateKey))
	if block == nil {
		return nil, errors.New("the service account key's private_key isn't PEM")
	}
	var key *rsa.PrivateKey
	if k, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		rk, ok := k.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("the service account key's private_key isn't RSA")
		}
		key = rk
	} else if rk, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		key = rk
	} else {
		return nil, errors.New("the service account key's private_key doesn't parse")
	}
	tokenURI := sa.TokenURI
	if tokenURI == "" {
		tokenURI = "https://oauth2.googleapis.com/token"
	}
	if u, err := url.Parse(tokenURI); err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, errors.New("the service account key's token_uri isn't an https URL")
	}
	return &tokenSource{email: sa.ClientEmail, keyID: sa.PrivateKeyID, tokenURI: tokenURI, key: key, http: httpClient, now: now}, nil
}

// Token is an access token good for at least another minute.
func (t *tokenSource) Token(ctx context.Context) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.token != "" && t.now().Before(t.expires.Add(-time.Minute)) {
		return t.token, nil
	}
	assertion, err := t.assertion()
	if err != nil {
		return "", err
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {assertion}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.tokenURI, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := t.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("service account token: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		// Google's error body names the problem, never the key.
		var e struct {
			Error string `json:"error"`
			Desc  string `json:"error_description"`
		}
		_ = json.Unmarshal(body, &e)
		if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnauthorized {
			return "", fmt.Errorf("%w: service account token: %s %s", ErrDenied, e.Error, e.Desc)
		}
		return "", fmt.Errorf("service account token: HTTP %d %s", resp.StatusCode, e.Error)
	}
	var ok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &ok); err != nil || ok.AccessToken == "" {
		return "", errors.New("service account token: the answer has no access_token")
	}
	t.token = ok.AccessToken
	t.expires = t.now().Add(time.Duration(max(ok.ExpiresIn, 60)) * time.Second)
	return t.token, nil
}

// Forget drops the token held, so the next request trades for a new one (the store refused it).
func (t *tokenSource) Forget() {
	t.mu.Lock()
	t.token = ""
	t.mu.Unlock()
}

// assertion is the JWT the token endpoint takes: signed with the key, for an hour, read-only scope.
func (t *tokenSource) assertion() (string, error) {
	now := t.now().UTC()
	header := map[string]string{"alg": "RS256", "typ": "JWT"}
	if t.keyID != "" {
		header["kid"] = t.keyID
	}
	claims := map[string]any{
		"iss": t.email, "scope": gcsScope, "aud": t.tokenURI,
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
	}
	h, _ := json.Marshal(header)
	c, _ := json.Marshal(claims)
	enc := base64.RawURLEncoding
	signing := enc.EncodeToString(h) + "." + enc.EncodeToString(c)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(nil, t.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", fmt.Errorf("service account token: signing: %w", err)
	}
	return signing + "." + enc.EncodeToString(sig), nil
}
