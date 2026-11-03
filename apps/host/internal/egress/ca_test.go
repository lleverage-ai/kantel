package egress

import (
	"crypto/x509"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestCANameConstraints(t *testing.T) {
	ca, err := NewCA("sbx_1", []string{"API.github.com.", "*.example.com", "*", "10.0.0.1", "localhost"})
	if err != nil {
		t.Fatal(err)
	}
	// "*", an address and a name without a dot can't be constrained to, so they are never intercepted.
	if got := ca.Hosts(); !slices.Equal(got, []string{"*.example.com", "api.github.com"}) {
		t.Fatalf("hosts %v", got)
	}
	c := ca.Certificate()
	if !c.PermittedDNSDomainsCritical || !slices.Equal(c.PermittedDNSDomains, []string{".example.com", "api.github.com"}) || !c.MaxPathLenZero {
		t.Fatalf("constraints %v critical=%v maxPathLenZero=%v", c.PermittedDNSDomains, c.PermittedDNSDomainsCritical, c.MaxPathLenZero)
	}
	roots := x509.NewCertPool()
	roots.AddCert(c)
	verify := func(host string, leaf *x509.Certificate) error {
		_, err := leaf.Verify(x509.VerifyOptions{DNSName: host, Roots: roots})
		return err
	}
	for _, host := range []string{"api.github.com", "uploads.example.com"} {
		l, err := ca.Leaf(host)
		if err != nil {
			t.Fatalf("%s: %v", host, err)
		}
		if err := verify(host, l.Leaf); err != nil {
			t.Fatalf("%s: %v", host, err)
		}
		again, _ := ca.Leaf(host)
		if again != l {
			t.Errorf("%s: leaf not cached", host)
		}
	}
	for _, host := range []string{"evil.com", "example.com", "github.com", "api.github.com.evil.com"} {
		if _, err := ca.Leaf(host); err == nil {
			t.Errorf("Leaf(%s) minted a leaf for a host the CA isn't for", host)
		}
		// Even a leaf the CA's key signs for another name (as a leaked key could) isn't trusted for it.
		l, err := ca.mint(host)
		if err != nil {
			t.Fatal(err)
		}
		err = verify(host, l.Leaf)
		var invalid x509.CertificateInvalidError
		if !errors.As(err, &invalid) || invalid.Reason != x509.CANotAuthorizedForThisName {
			t.Errorf("%s: verified with %v, want a name-constraint error", host, err)
		}
	}
}

func TestCAStore(t *testing.T) {
	dir := t.TempDir()
	s := NewCAStore(dir)
	if _, err := s.Get("sbx_1"); !errors.Is(err, ErrNoCA) {
		t.Fatalf("Get before Ensure: %v", err)
	}
	ca, fresh, err := s.Ensure("sbx_1", []string{"api.github.com"})
	if err != nil || !fresh {
		t.Fatalf("Ensure: %v fresh=%v", err, fresh)
	}
	info, err := os.Stat(filepath.Join(dir, "sbx_1", "ca.key"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("ca.key: %v %v", info, err)
	}
	if again, fresh, err := s.Ensure("sbx_1", []string{"API.github.com"}); err != nil || fresh || again != ca {
		t.Fatalf("Ensure with the same hosts made a new CA: %v fresh=%v", err, fresh)
	}
	// A restarted host reloads the CA its sandbox already trusts.
	reloaded, err := NewCAStore(dir).Get("sbx_1")
	if err != nil || reloaded.CertPEM() != ca.CertPEM() {
		t.Fatalf("reload: %v", err)
	}
	if _, err := reloaded.Leaf("api.github.com"); err != nil {
		t.Fatalf("reloaded CA can't mint: %v", err)
	}
	if next, fresh, err := s.Ensure("sbx_1", []string{"api.github.com", "uploads.github.com"}); err != nil || !fresh || next.CertPEM() == ca.CertPEM() {
		t.Fatalf("Ensure with new hosts: %v fresh=%v", err, fresh)
	}
	if _, _, err := s.Ensure("../escape", []string{"api.github.com"}); err == nil {
		t.Fatal("Ensure took an ID that isn't a directory name")
	}
	if err := s.Forget("sbx_1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get("sbx_1"); !errors.Is(err, ErrNoCA) {
		t.Fatalf("Get after Forget: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "sbx_1")); !os.IsNotExist(err) {
		t.Fatalf("Forget left %v", err)
	}
}
