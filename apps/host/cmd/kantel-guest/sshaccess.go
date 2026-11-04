package main

import (
	"fmt"
	"io"
	"os"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
)

// fingerprintMark separates the private key from the host key's fingerprint, as packages/hosts' SSH access script
// prints them (FINGERPRINT_MARK).
const fingerprintMark = "--kantel-host-key--"

// sshAccess is the SSH access script's step for an image without ssh-keygen: the injected agent's own.
func sshAccess(stdout, stderr io.Writer) int {
	privateKey, fingerprint, err := guest.SSHAccess(os.Getenv("KANTEL_PUBLIC_KEY"))
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprint(stdout, privateKey)
	fmt.Fprintln(stdout, fingerprintMark)
	// ssh-keygen -lf prints "SHA256:…", which the script cuts out of its line.
	fmt.Fprintln(stdout, fingerprint)
	return 0
}
