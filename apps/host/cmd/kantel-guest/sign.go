package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/vsock"
)

// kantel-sign is Git's signing program in a sandbox with a signing key (gpg.program, or gpg.ssh.program): it sends
// the commit or tag Git asks it to sign to the host (guest.SignPort), which holds the key and signs only Git objects
// whose committer or tagger its key may sign for. Everything else (verifying, listing) goes to the real gpg or
// ssh-keygen. This file imports no OpenPGP library: the guest binary carries none.

// maxSignPayload is the most kantel-sign reads to sign (the host's bound): one byte more is sent, for the host to
// refuse and record.
const maxSignPayload = 256 * 1024

var (
	// signDial connects to the host's signing socket; tests point it at a Unix socket.
	signDial = func(context.Context) (net.Conn, error) { return vsock.DialHost(guest.SignPort) }
	// signPubFile is the key's public half, which verifying with gpg imports.
	signPubFile = guest.SigningPubFile
	// verifyHome is the GnuPG home kantel-sign verifies with for a user.
	verifyHome = func(uid int) string { return fmt.Sprintf("/tmp/kantel-gpg-verify-%d", uid) }
	// execProgram replaces this process with another (keeping every file descriptor, so --status-fd works).
	execProgram = syscall.Exec
)

const (
	systemGPG       = "/usr/bin/gpg"
	systemSSHKeygen = "/usr/bin/ssh-keygen"
	signTimeout     = 30 * time.Second
)

// signMain is kantel-sign: an ssh-keygen invocation (-Y) or a gpg one.
func signMain(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	for _, a := range args {
		if a == "-Y" {
			return sshSignMain(args, stdout, stderr)
		}
	}
	// Git asks ssh-keygen -lf <key> for a key's fingerprint (push certificates): the real one answers.
	if len(args) > 0 && args[0] == "-lf" {
		return runReal(systemSSHKeygen, args, stderr)
	}
	return gpgSignMain(args, stdin, stdout, stderr)
}

// sshSignMain is kantel-sign as gpg.ssh.program: -Y sign signs through the host; any other -Y op is ssh-keygen's.
func sshSignMain(args []string, stdout, stderr io.Writer) int {
	var op, namespace string
	var files []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch a {
		case "-Y", "-n", "-f", "-O", "-I", "-s":
			if i+1 >= len(args) {
				fmt.Fprintf(stderr, "kantel-sign: %s needs a value\n", a)
				return 2
			}
			switch a {
			case "-Y":
				op = args[i+1]
			case "-n":
				namespace = args[i+1]
			}
			i++
		case "-U", "-q", "-v":
		default:
			if strings.HasPrefix(a, "-") {
				break
			}
			files = append(files, a)
		}
	}
	if op != "sign" {
		return runReal(systemSSHKeygen, args, stderr)
	}
	if namespace != "git" {
		fmt.Fprintf(stderr, "kantel-sign: signs only in the git namespace, not %q\n", namespace)
		return 2
	}
	if len(files) != 1 {
		fmt.Fprintln(stderr, "kantel-sign: -Y sign needs the one file to sign")
		return 2
	}
	payload, err := readPayloadFile(files[0])
	if err != nil {
		fmt.Fprintf(stderr, "kantel-sign: %v\n", err)
		return 2
	}
	answer, err := hostSign(context.Background(), "ssh", payload)
	if err != nil {
		fmt.Fprintf(stderr, "kantel-sign: %v\n", err)
		return 2
	}
	if err := os.WriteFile(files[0]+".sig", []byte(answer.Signature), 0o644); err != nil {
		fmt.Fprintf(stderr, "kantel-sign: %v\n", err)
		return 2
	}
	return 0
}

// gpgArgs is what kantel-sign reads of a gpg command line.
type gpgArgs struct {
	sign, detach, verify bool
	homedir              bool
	statusFD             int
	output               string
	files                []string
}

// gpgValued are gpg's long options that take a value, as --name=value or --name value.
var gpgValued = map[string]bool{
	"status-fd": true, "output": true, "local-user": true, "default-key": true, "keyid-format": true,
	"digest-algo": true, "homedir": true, "trust-model": true, "compress-algo": true, "passphrase-fd": true,
	"pinentry-mode": true, "logger-fd": true, "attribute-fd": true, "command-fd": true, "options": true,
	"keyring": true, "trustdb-name": true, "cert-digest-algo": true, "personal-digest-preferences": true,
}

// gpgShortValued are gpg's short options that take a value: in the rest of their cluster, or the next argument.
var gpgShortValued = map[byte]string{'u': "local-user", 'o': "output", 'r': "recipient"}

func parseGPGArgs(args []string) (gpgArgs, error) {
	g := gpgArgs{statusFD: -1}
	set := func(name, value string) error {
		switch name {
		case "status-fd":
			fd, err := strconv.Atoi(value)
			if err != nil || fd < 0 {
				return fmt.Errorf("--status-fd %q isn't a file descriptor", value)
			}
			g.statusFD = fd
		case "output":
			g.output = value
		case "homedir":
			g.homedir = true
		}
		return nil
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			g.files = append(g.files, args[i+1:]...)
			return g, nil
		case strings.HasPrefix(a, "--"):
			name, value, hasValue := strings.Cut(a[2:], "=")
			switch name {
			case "sign":
				g.sign = true
			case "detach-sign":
				g.sign, g.detach = true, true
			case "verify":
				g.verify = true
			}
			if gpgValued[name] {
				if !hasValue {
					if i+1 >= len(args) {
						return g, fmt.Errorf("--%s needs a value", name)
					}
					i++
					value = args[i]
				}
				if err := set(name, value); err != nil {
					return g, err
				}
			}
		case len(a) > 1 && a[0] == '-':
			for j := 1; j < len(a); j++ {
				c := a[j]
				switch c {
				case 's':
					g.sign = true
				case 'b':
					g.sign, g.detach = true, true
				}
				if name, ok := gpgShortValued[c]; ok {
					value := a[j+1:]
					if value == "" {
						if i+1 >= len(args) {
							return g, fmt.Errorf("-%c needs a value", c)
						}
						i++
						value = args[i]
					}
					if err := set(name, value); err != nil {
						return g, err
					}
					break
				}
			}
		default:
			g.files = append(g.files, a)
		}
	}
	return g, nil
}

// gpgSignMain is kantel-sign as gpg.program: a detached signature through the host, or the real gpg for the rest.
func gpgSignMain(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	g, err := parseGPGArgs(args)
	if err != nil {
		fmt.Fprintf(stderr, "kantel-sign: %v\n", err)
		return 2
	}
	if g.verify || !g.sign {
		return gpgVerify(args, g, stderr)
	}
	status := statusWriter(g.statusFD, stdout, stderr)
	failed := func(err error) int {
		if status != nil {
			// gpg's FAILURE status line: where it failed, and an error code (1, GPG_ERR_GENERAL).
			fmt.Fprint(status, "[GNUPG:] FAILURE sign 1\n")
		}
		fmt.Fprintf(stderr, "kantel-sign: %v\n", err)
		return 2
	}
	if !g.detach {
		return failed(errors.New("only detached signatures (gpg -b) are made, as Git asks"))
	}
	var payload []byte
	switch {
	case len(g.files) > 1:
		return failed(errors.New("one file to sign at most"))
	case len(g.files) == 1 && g.files[0] != "-":
		payload, err = readPayloadFile(g.files[0])
	default:
		payload, err = io.ReadAll(io.LimitReader(stdin, maxSignPayload+1))
	}
	if err != nil {
		return failed(err)
	}
	answer, err := hostSign(context.Background(), "gpg", payload)
	if err != nil {
		return failed(err)
	}
	out := stdout
	if g.output != "" && g.output != "-" {
		f, err := os.OpenFile(g.output, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return failed(err)
		}
		defer f.Close()
		out = f
	}
	if _, err := io.WriteString(out, answer.Signature); err != nil {
		return failed(err)
	}
	if status != nil {
		fmt.Fprintf(status, "[GNUPG:] BEGIN_SIGNING H%d\n[GNUPG:] SIG_CREATED D %d %d 00 %d %s\n",
			answer.HashAlgo, answer.PKAlgo, answer.HashAlgo, answer.Timestamp, answer.Fingerprint)
	}
	return 0
}

// statusWriter is gpg's --status-fd: stdout or stderr for 1 or 2, else the inherited descriptor (nil for none).
func statusWriter(fd int, stdout, stderr io.Writer) io.Writer {
	switch fd {
	case -1:
		return nil
	case 1:
		return stdout
	case 2:
		return stderr
	default:
		return os.NewFile(uintptr(fd), "status-fd")
	}
}

// gpgVerify runs the real gpg with what it was asked: with a keyring holding the sandbox's signing key, when the
// sandbox has an OpenPGP one and the caller names no keyring of its own.
func gpgVerify(args []string, g gpgArgs, stderr io.Writer) int {
	if !g.homedir {
		if home, err := verifyKeyring(stderr); err == nil && home != "" {
			args = append([]string{"--homedir", home}, args...)
		} else if err != nil {
			fmt.Fprintf(stderr, "kantel-sign: the signing key's keyring: %v\n", err)
		}
	}
	return runReal(systemGPG, args, stderr)
}

// verifyKeyring is this user's GnuPG home with signPubFile imported (once for each key): "" when the sandbox has no
// OpenPGP key.
func verifyKeyring(stderr io.Writer) (string, error) {
	pub, err := os.ReadFile(signPubFile)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !bytes.Contains(pub, []byte("-----BEGIN PGP PUBLIC KEY BLOCK-----")) {
		return "", nil
	}
	uid := os.Getuid()
	home := verifyHome(uid)
	if err := os.Mkdir(home, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	// Another user could have made it first, in /tmp: only a directory of this user's own, closed to others, is used.
	info, err := os.Lstat(home)
	if err != nil {
		return "", err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || !ok || int(st.Uid) != uid || info.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("%s isn't a directory of this user's own (mode 0700)", home)
	}
	sum := sha256.Sum256(pub)
	want := hex.EncodeToString(sum[:])
	marker := filepath.Join(home, ".sha256")
	if got, err := os.ReadFile(marker); err == nil && strings.TrimSpace(string(got)) == want {
		return home, nil
	}
	cmd := exec.Command(systemGPG, "--homedir", home, "--batch", "--quiet", "--import", signPubFile)
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("gpg --import: %w", err)
	}
	if err := os.WriteFile(marker, []byte(want+"\n"), 0o600); err != nil {
		return "", err
	}
	return home, nil
}

// runReal replaces kantel-sign with program, given args, in this process's environment.
func runReal(program string, args []string, stderr io.Writer) int {
	err := execProgram(program, append([]string{filepath.Base(program)}, args...), os.Environ())
	fmt.Fprintf(stderr, "kantel-sign: %s: %v\n", program, err)
	return 2
}

func readPayloadFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, maxSignPayload+1))
}

// hostSign asks the host to sign payload in format.
func hostSign(ctx context.Context, format string, payload []byte) (guest.SignAnswer, error) {
	ctx, cancel := context.WithTimeout(ctx, signTimeout)
	defer cancel()
	body, err := json.Marshal(guest.SignRequest{Format: format, Payload: base64.StdEncoding.EncodeToString(payload)})
	if err != nil {
		return guest.SignAnswer{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://kantel-host/sign", bytes.NewReader(body))
	if err != nil {
		return guest.SignAnswer{}, err
	}
	req.Header.Set("content-type", "application/json")
	var answer guest.SignAnswer
	if err := signCall(req, &answer); err != nil {
		return guest.SignAnswer{}, err
	}
	if answer.Signature == "" {
		return guest.SignAnswer{}, errors.New("the host answered no signature")
	}
	return answer, nil
}

// hostSignStatus is the host's GET /status for this sandbox.
func hostSignStatus(ctx context.Context) (guest.SignStatus, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://kantel-host/status", nil)
	if err != nil {
		return guest.SignStatus{}, err
	}
	var st guest.SignStatus
	return st, signCall(req, &st)
}

// signCall sends req to the host's signing socket and decodes its answer into out; a refusal is its error.
func signCall(req *http.Request, out any) error {
	client := &http.Client{Transport: &http.Transport{
		DialContext:       func(ctx context.Context, _, _ string) (net.Conn, error) { return signDial(ctx) },
		DisableKeepAlives: true,
	}}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("the host's signing isn't reachable: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		var refusal struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(raw, &refusal) == nil && refusal.Error != "" {
			return fmt.Errorf("the host refused (%d): %s", res.StatusCode, refusal.Error)
		}
		return fmt.Errorf("the host refused (%d)", res.StatusCode)
	}
	return json.Unmarshal(raw, out)
}
