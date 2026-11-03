package egress

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// caValidity is a sandbox CA's lifetime: longer than any sandbox lives, since the guest trusts this one cert and a
// new one means installing it again.
const caValidity = 10 * 365 * 24 * time.Hour

// leafValidity is a minted leaf's lifetime; a cached leaf is minted again once half of it has gone.
const leafValidity = 7 * 24 * time.Hour

// CA is one sandbox's certificate authority, which the proxy signs the leaf certificates of the hosts it intercepts
// with. It is name-constrained to those hosts, so even its key, were it to leak, couldn't vouch for any other name
// to the sandbox. The key stays on the host: only the certificate goes into the guest.
type CA struct {
	cert    *x509.Certificate
	certPEM string
	key     *ecdsa.PrivateKey
	hosts   []string
	// leafKey is shared by every leaf: a fresh key per host would cost a key generation on each new name and buy
	// nothing, as every leaf is the same CA's in the same process.
	leafKey *ecdsa.PrivateKey

	mu     sync.Mutex
	leaves map[string]*tls.Certificate
}

// NewCA mints a CA for hosts ("api.github.com", "*.example.com"). name goes into its subject, for whoever reads the
// guest's trust store.
func NewCA(name string, hosts []string) (*CA, error) {
	hosts = normaliseHosts(hosts)
	if len(hosts) == 0 {
		return nil, errors.New("egress: a sandbox CA needs at least one host to be constrained to")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	permitted := make([]string, len(hosts))
	for i, h := range hosts {
		// x509 writes "any subdomain of" as a leading dot; a name without one also covers its subdomains, which
		// Leaf never mints.
		permitted[i] = strings.TrimPrefix(h, "*")
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{Organization: []string{"Kantel"}, CommonName: "Kantel egress " + name},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(caValidity),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
		// RFC 5280 has name constraints critical, so a client that can't apply them refuses the CA rather than
		// trusting it for everything.
		PermittedDNSDomainsCritical: true,
		PermittedDNSDomains:         permitted,
		ExcludedIPRanges: []*net.IPNet{
			{IP: net.IPv4zero.To4(), Mask: net.CIDRMask(0, 32)},
			{IP: net.IPv6zero, Mask: net.CIDRMask(0, 128)},
		},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return newCA(cert, key)
}

func newCA(cert *x509.Certificate, key *ecdsa.PrivateKey) (*CA, error) {
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	hosts := make([]string, 0, len(cert.PermittedDNSDomains))
	for _, d := range cert.PermittedDNSDomains {
		if strings.HasPrefix(d, ".") {
			d = "*" + d
		}
		hosts = append(hosts, d)
	}
	return &CA{
		cert:    cert,
		certPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw})),
		key:     key,
		hosts:   normaliseHosts(hosts),
		leafKey: leafKey,
		leaves:  map[string]*tls.Certificate{},
	}, nil
}

// CertPEM is the CA's certificate, for the guest's trust store.
func (c *CA) CertPEM() string { return c.certPEM }

// Certificate is the CA's certificate.
func (c *CA) Certificate() *x509.Certificate { return c.cert }

// Hosts are the host patterns the CA is constrained to, sorted.
func (c *CA) Hosts() []string { return slices.Clone(c.hosts) }

// Covers says whether host is one of the CA's names.
func (c *CA) Covers(host string) bool {
	host = normaliseHost(host)
	return slices.ContainsFunc(c.hosts, func(p string) bool { return patternMatches(p, host) })
}

// Leaf answers a certificate for host signed by the CA, minted on first use and cached.
func (c *CA) Leaf(host string) (*tls.Certificate, error) {
	host = normaliseHost(host)
	if !c.Covers(host) {
		return nil, fmt.Errorf("egress: %s isn't one of this sandbox's intercepted hosts", host)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if l, ok := c.leaves[host]; ok && time.Until(l.Leaf.NotAfter) > leafValidity/2 {
		return l, nil
	}
	l, err := c.mint(host)
	if err != nil {
		return nil, err
	}
	c.leaves[host] = l
	return l, nil
}

// mint signs a leaf for host whether or not the CA covers it: Leaf checks first, and the tests use this to show the
// name constraints hold without that check.
func (c *CA) mint(host string) (*tls.Certificate, error) {
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	notAfter := now.Add(leafValidity)
	if notAfter.After(c.cert.NotAfter) {
		notAfter = c.cert.NotAfter
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: host},
		DNSNames:     []string{host},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, &c.leafKey.PublicKey, c.key)
	if err != nil {
		return nil, err
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return &tls.Certificate{Certificate: [][]byte{der, c.cert.Raw}, PrivateKey: c.leafKey, Leaf: leaf}, nil
}

func randomSerial() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
}

// CAStore holds each sandbox's CA: in memory, and under dir/<sandbox>/ (the key at 0600) so a host restart keeps
// the CA its running sandboxes already trust. Nothing in it is ever written into a guest but the certificate.
type CAStore struct {
	dir string

	mu  sync.Mutex
	cas map[string]*CA
	// installed is, for each sandbox, the fingerprint of the CA its running guest was last confirmed to trust.
	installed map[string]string
}

// NewCAStore keeps CAs under dir.
func NewCAStore(dir string) *CAStore {
	return &CAStore{dir: dir, cas: map[string]*CA{}, installed: map[string]string{}}
}

// Fingerprint is the SHA-256 of the CA's certificate, in hex.
func (c *CA) Fingerprint() string {
	sum := sha256.Sum256(c.cert.Raw)
	return hex.EncodeToString(sum[:])
}

// Installed says whether the sandbox's guest has been confirmed to trust its current CA. A CA made since (a new
// intercept set) isn't, so an install that failed is tried again rather than taken as done.
func (s *CAStore) Installed(sandboxID string) bool {
	if !safeID(sandboxID) {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ca, err := s.getLocked(sandboxID)
	if err != nil {
		return false
	}
	have, ok := s.installed[sandboxID]
	if !ok && s.dir != "" {
		raw, _ := os.ReadFile(filepath.Join(s.dir, sandboxID, "installed"))
		have = strings.TrimSpace(string(raw))
		s.installed[sandboxID] = have
	}
	return have != "" && have == ca.Fingerprint()
}

// MarkInstalled records that the sandbox's guest now trusts ca, kept beside the CA so a host restart remembers.
func (s *CAStore) MarkInstalled(sandboxID string, ca *CA) error {
	if !safeID(sandboxID) || ca == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if have, err := s.getLocked(sandboxID); err != nil || have.Fingerprint() != ca.Fingerprint() {
		// Replaced meanwhile: the guest trusts one the proxy no longer uses.
		return nil
	}
	s.installed[sandboxID] = ca.Fingerprint()
	if s.dir == "" {
		return nil
	}
	return writeFile0600(filepath.Join(s.dir, sandboxID, "installed"), []byte(ca.Fingerprint()+"\n"))
}

// ErrNoCA is a sandbox with no CA: nothing it does is intercepted.
var ErrNoCA = errors.New("egress: this sandbox has no interception CA")

// Get answers a sandbox's CA, from memory or its state dir.
func (s *CAStore) Get(sandboxID string) (*CA, error) {
	if !safeID(sandboxID) {
		return nil, ErrNoCA
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getLocked(sandboxID)
}

func (s *CAStore) getLocked(sandboxID string) (*CA, error) {
	if ca, ok := s.cas[sandboxID]; ok {
		return ca, nil
	}
	ca, err := s.load(sandboxID)
	if err != nil {
		return nil, err
	}
	s.cas[sandboxID] = ca
	return ca, nil
}

// Ensure answers the sandbox's CA for hosts: the one it has when it is constrained to exactly those hosts, else a
// new one (saved before it is answered); fresh says it is new, and so must be installed in the guest.
func (s *CAStore) Ensure(sandboxID string, hosts []string) (ca *CA, fresh bool, err error) {
	if !safeID(sandboxID) {
		return nil, false, fmt.Errorf("egress: bad sandbox ID %q", sandboxID)
	}
	want := normaliseHosts(hosts)
	s.mu.Lock()
	defer s.mu.Unlock()
	if have, err := s.getLocked(sandboxID); err == nil && slices.Equal(have.hosts, want) {
		return have, false, nil
	}
	ca, err = NewCA(sandboxID, want)
	if err != nil {
		return nil, false, err
	}
	if err := s.save(sandboxID, ca); err != nil {
		return nil, false, err
	}
	s.cas[sandboxID] = ca
	return ca, true, nil
}

// Forget drops a sandbox's CA, key and all.
func (s *CAStore) Forget(sandboxID string) error {
	if !safeID(sandboxID) {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.cas, sandboxID)
	delete(s.installed, sandboxID)
	if s.dir == "" {
		return nil
	}
	return os.RemoveAll(filepath.Join(s.dir, sandboxID))
}

func (s *CAStore) save(sandboxID string, ca *CA) error {
	if s.dir == "" {
		return nil
	}
	dir := filepath.Join(s.dir, sandboxID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	der, err := x509.MarshalPKCS8PrivateKey(ca.key)
	if err != nil {
		return err
	}
	// The key first: a cert without its key is no CA, and load refuses the pair rather than half of it.
	if err := writeFile0600(filepath.Join(dir, "ca.key"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})); err != nil {
		return err
	}
	return writeFile0600(filepath.Join(dir, "ca.crt"), []byte(ca.certPEM))
}

func (s *CAStore) load(sandboxID string) (*CA, error) {
	if s.dir == "" {
		return nil, ErrNoCA
	}
	dir := filepath.Join(s.dir, sandboxID)
	certPEM, err := os.ReadFile(filepath.Join(dir, "ca.crt"))
	if err != nil {
		return nil, ErrNoCA
	}
	keyPEM, err := os.ReadFile(filepath.Join(dir, "ca.key"))
	if err != nil {
		return nil, ErrNoCA
	}
	cb, _ := pem.Decode(certPEM)
	kb, _ := pem.Decode(keyPEM)
	if cb == nil || kb == nil {
		return nil, fmt.Errorf("egress: %s's CA files are damaged", sandboxID)
	}
	cert, err := x509.ParseCertificate(cb.Bytes)
	if err != nil {
		return nil, fmt.Errorf("egress: %s's CA certificate: %w", sandboxID, err)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(kb.Bytes)
	if err != nil {
		return nil, fmt.Errorf("egress: %s's CA key: %w", sandboxID, err)
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok || !key.PublicKey.Equal(cert.PublicKey) {
		return nil, fmt.Errorf("egress: %s's CA key isn't its certificate's", sandboxID)
	}
	return newCA(cert, key)
}

func writeFile0600(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// safeID is a sandbox ID that is safe as a directory name.
func safeID(id string) bool {
	if id == "" || len(id) > 100 {
		return false
	}
	for _, r := range id {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

// normaliseHost lowercases a host and drops a trailing dot.
func normaliseHost(h string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(h)), ".")
}

// interceptable is a host pattern a CA can be constrained to: a name, or "*." and a name. "*" alone (every host)
// can't be, so it is never intercepted.
func interceptable(p string) bool {
	rest := strings.TrimPrefix(p, "*.")
	return rest != "" && !strings.ContainsAny(rest, "*/:[] ") && strings.Contains(p, ".") && net.ParseIP(rest) == nil
}

// normaliseHosts answers the interceptable patterns in hosts, normalised, sorted and without repeats.
func normaliseHosts(hosts []string) []string {
	out := make([]string, 0, len(hosts))
	for _, h := range hosts {
		if h = normaliseHost(h); interceptable(h) {
			out = append(out, h)
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// patternMatches says whether host is pattern's: "*" is every host, "*.example.com" any subdomain of example.com
// (not example.com itself), anything else that host only.
func patternMatches(pattern, host string) bool {
	pattern, host = normaliseHost(pattern), normaliseHost(host)
	if pattern == "" || host == "" {
		return false
	}
	if pattern == "*" {
		return true
	}
	if suffix, ok := strings.CutPrefix(pattern, "*"); ok {
		if !strings.HasPrefix(suffix, ".") || len(host) <= len(suffix) || !strings.HasSuffix(host, suffix) {
			return false
		}
		return !strings.HasSuffix(host[:len(host)-len(suffix)], ".")
	}
	return host == pattern
}
