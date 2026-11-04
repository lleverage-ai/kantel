//go:build vmtest

// Real-VM tests of the injected guest agent (injectGuestAgent): each image boots through Kantel's initramfs, with
// nothing of Kantel's in it, and the agent must give commands, files, a port, SSH (a command, a terminal and a
// forwarded port) and a true report of what the image has, then survive a stop and a cold boot from its own disk.
//
// They need root, /dev/kvm, Firecracker, the guest kernel, a static kantel-guest and the images, so they run only
// with the vmtest tag (apps/host/test/injected.sh builds the images and runs them in a privileged container):
//
//	KANTEL_VMTEST_KERNEL=/images/vmlinux-x86_64 KANTEL_VMTEST_FIRECRACKER=/opt/firecracker \
//	KANTEL_VMTEST_AGENT=/opt/kantel-guest KANTEL_VMTEST_INJECT_IMAGES=kantel=/images/sandbox-amd64.ext4,alpine=/images/alpine.sqfs \
//	  go test -tags vmtest -run Injected -v ./internal/microvm/
package microvm

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/lleverage-ai/kantel/apps/host/internal/guestinit"
	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// expectation is what an image is.
type expectation struct {
	osID, libc, init string
	desktop, docker  bool
	// listen starts a server on 127.0.0.1:8000 that answers anything with "kantel-port-ok".
	listen string
}

const perlListen = `perl -MIO::Socket::INET -e '$s=IO::Socket::INET->new(LocalAddr=>"127.0.0.1",LocalPort=>8000,Listen=>5,ReuseAddr=>1) or die; while($c=$s->accept){$l=<$c>; print $c "HTTP/1.0 200 OK\r\n\r\nkantel-port-ok"; close $c}'`

const ncListen = `while true; do printf 'HTTP/1.0 200 OK\r\n\r\nkantel-port-ok' | nc -l -p 8000 -s 127.0.0.1 >/dev/null 2>&1 || nc -l -p 8000 >/dev/null 2>&1 <<EOF
HTTP/1.0 200 OK

kantel-port-ok
EOF
done`

var expectations = map[string]expectation{
	"kantel":  {osID: "ubuntu", libc: "glibc", init: "systemd", desktop: true, docker: true, listen: perlListen},
	"debian":  {osID: "debian", libc: "glibc", init: "kantel", listen: perlListen},
	"alpine":  {osID: "alpine", libc: "musl", init: "kantel", listen: ncListen},
	"busybox": {osID: "busybox", init: "kantel", listen: ncListen},
}

func TestInjectedAgent(t *testing.T) {
	kernel, firecracker, agent := os.Getenv("KANTEL_VMTEST_KERNEL"), os.Getenv("KANTEL_VMTEST_FIRECRACKER"), os.Getenv("KANTEL_VMTEST_AGENT")
	images := os.Getenv("KANTEL_VMTEST_INJECT_IMAGES")
	if kernel == "" || firecracker == "" || agent == "" || images == "" {
		t.Skip("KANTEL_VMTEST_KERNEL, KANTEL_VMTEST_FIRECRACKER, KANTEL_VMTEST_AGENT and KANTEL_VMTEST_INJECT_IMAGES")
	}
	root := t.TempDir()
	initrd, err := guestinit.Build(filepath.Join(root, "initramfs"), agent)
	if err != nil {
		t.Fatal(err)
	}
	netm, err := network.New("10.231.0.0/16", 3129, false)
	if err != nil {
		t.Fatal(err)
	}
	for i, spec := range strings.Split(images, ",") {
		name, path, _ := strings.Cut(spec, "=")
		want, ok := expectations[name]
		if !ok {
			t.Fatalf("no expectations for image %q", name)
		}
		t.Run(name, func(t *testing.T) {
			m, err := New(Config{
				Root: filepath.Join(root, name), Firecracker: firecracker, Kernel: kernel, Rootfs: path, Initrd: initrd,
				Sizes: []proto.Size{{Name: "default", VCPUs: 2, MemoryMiB: 2048, DiskGiB: 4}}, Network: netm, ProxyPort: 3129,
				Log: slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})),
			})
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
			defer cancel()
			id := fmt.Sprintf("sbx_inject%d", i)
			began := time.Now()
			info, err := m.Create(ctx, proto.CreateParams{SandboxID: id, Tier: Tier, Size: "default", Egress: &proto.Egress{Mode: network.EgressNone}})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = m.Delete(context.Background(), id) }()
			t.Logf("created in %s (template included): %v", time.Since(began).Round(time.Millisecond), info.Timings)
			checkReport(t, info.Guest, want)

			exec := func(p proto.ExecParams) proto.ExecResult {
				t.Helper()
				p.SandboxID = id
				res, err := m.Exec(ctx, p, nil)
				if err != nil {
					t.Fatalf("exec %q %v: %v", p.Command, p.Argv, err)
				}
				return res
			}
			// In /home/user, as the compute API sends every command: the agent makes it in a stock image.
			res := exec(proto.ExecParams{Command: "id -un; uname -m; echo $SHELL", Cwd: "/home/user"})
			t.Logf("exec: %q %q", res.Stdout, res.Stderr)
			if res.ExitCode != 0 || !strings.Contains(res.Stdout, "x86_64") {
				t.Fatalf("exec: %+v", res)
			}
			wantUser := "root"
			if name == "kantel" {
				wantUser = "user"
			}
			if got := strings.Fields(res.Stdout)[0]; got != wantUser {
				t.Errorf("runs as %s, want %s", got, wantUser)
			}
			if res := exec(proto.ExecParams{Argv: []string{"/bin/sh", "-c", "exit 7"}}); res.ExitCode != 7 {
				t.Errorf("argv exit code %d, want 7", res.ExitCode)
			}
			if res, err := m.Exec(ctx, proto.ExecParams{SandboxID: id, Command: "true", Cwd: "/nowhere"}, nil); err == nil && !strings.Contains(res.Stderr+fmt.Sprint(err), "no directory /nowhere") {
				t.Errorf("a missing cwd: %+v", res)
			} else if err != nil && !strings.Contains(err.Error(), "no directory /nowhere") {
				t.Errorf("a missing cwd: %v", err)
			}

			// Files.
			data := "hello from the host\n"
			// Not /tmp: Ubuntu's systemd mounts a tmpfs there, which a cold boot empties.
			if err := m.WriteFile(ctx, proto.FileParams{SandboxID: id, Path: "/opt/kantel-test/hello.txt", Data: base64.StdEncoding.EncodeToString([]byte(data))}, []byte(data)); err != nil {
				t.Fatal(err)
			}
			got, _, _, err := m.ReadFile(ctx, proto.FileParams{SandboxID: id, Path: "/opt/kantel-test/hello.txt"})
			if err != nil || string(got) != data {
				t.Fatalf("read back %q, %v", got, err)
			}
			if res := exec(proto.ExecParams{Command: "cat /opt/kantel-test/hello.txt"}); res.Stdout != data {
				t.Errorf("cat: %q", res.Stdout)
			}
			entries, err := m.ListFiles(ctx, proto.FileParams{SandboxID: id, Path: "/opt/kantel-test"})
			if err != nil || len(entries) != 1 {
				t.Errorf("list: %v %v", entries, err)
			}

			// A port, straight and through SSH.
			if res := exec(proto.ExecParams{Command: want.listen, Detached: true}); res.ExitCode != 0 && res.Pid == 0 {
				t.Fatalf("listener: %+v", res)
			}
			portOK := func(dial func() (io.ReadWriteCloser, error)) {
				t.Helper()
				deadline := time.Now().Add(10 * time.Second)
				for {
					conn, err := dial()
					if err == nil {
						_, _ = io.WriteString(conn, "GET / HTTP/1.0\r\n\r\n")
						body, _ := io.ReadAll(conn)
						conn.Close()
						if strings.Contains(string(body), "kantel-port-ok") {
							return
						}
						err = fmt.Errorf("answer %q", body)
					}
					if time.Now().After(deadline) {
						t.Fatalf("port 8000: %v", err)
					}
					time.Sleep(200 * time.Millisecond)
				}
			}
			portOK(func() (io.ReadWriteCloser, error) { return m.DialPort(ctx, id, 8000) })

			// SSH: the access script's step, then a command, a terminal and a forwarded port.
			pub, priv, _ := ed25519.GenerateKey(rand.Reader)
			sshPub, _ := ssh.NewPublicKey(pub)
			signer, _ := ssh.NewSignerFromKey(priv)
			access := exec(proto.ExecParams{Command: "/.kantel/bin/kantel-guest ssh-access", Env: map[string]string{"KANTEL_PUBLIC_KEY": strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPub)))}})
			if access.ExitCode != 0 {
				t.Fatalf("ssh-access: %+v", access)
			}
			_, fingerprint, _ := strings.Cut(access.Stdout, "--kantel-host-key--\n")
			fingerprint = strings.TrimSpace(fingerprint)
			conn, err := m.DialPort(ctx, id, 22)
			if err != nil {
				t.Fatal(err)
			}
			sc, chans, reqs, err := ssh.NewClientConn(conn, id, &ssh.ClientConfig{
				User: wantUser, Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)},
				HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
					if got := ssh.FingerprintSHA256(key); got != fingerprint {
						return fmt.Errorf("host key %s, ssh-access said %s", got, fingerprint)
					}
					return nil
				},
				Timeout: 10 * time.Second,
			})
			if err != nil {
				t.Fatalf("ssh: %v", err)
			}
			client := ssh.NewClient(sc, chans, reqs)
			defer client.Close()
			session, err := client.NewSession()
			if err != nil {
				t.Fatal(err)
			}
			out, err := session.CombinedOutput("echo ssh-ok; cat /opt/kantel-test/hello.txt; exit 3")
			if exitErr, ok := err.(*ssh.ExitError); !ok || exitErr.ExitStatus() != 3 || !strings.Contains(string(out), "ssh-ok") {
				t.Fatalf("ssh command: %q %v", out, err)
			}
			session, _ = client.NewSession()
			if err := session.RequestPty("xterm", 40, 100, ssh.TerminalModes{}); err != nil {
				t.Fatal(err)
			}
			stdin, _ := session.StdinPipe()
			stdout, _ := session.StdoutPipe()
			if err := session.Shell(); err != nil {
				t.Fatal(err)
			}
			_, _ = io.WriteString(stdin, "tty; echo pty-$((40+2)); exit\n")
			scanned, sawTTY := bufio.NewScanner(stdout), false
			sawAnswer := false
			for scanned.Scan() {
				line := scanned.Text()
				// bash wraps its output in bracketed-paste escapes, so not a prefix.
				if strings.Contains(line, "/dev/pts/") {
					sawTTY = true
				}
				if strings.Contains(line, "pty-42") && !strings.Contains(line, "echo") {
					sawAnswer = true
				}
			}
			_ = session.Wait()
			if !sawTTY || !sawAnswer {
				t.Errorf("terminal: tty %v, answer %v", sawTTY, sawAnswer)
			}
			portOK(func() (io.ReadWriteCloser, error) { return client.Dial("tcp", "127.0.0.1:8000") })
			client.Close()

			// Stop (no memory) and a cold boot from the sandbox's own disk, through the initramfs again.
			noMemory := false
			if _, err := m.Stop(ctx, proto.StopParams{SandboxID: id, SnapshotID: "snap_" + id, Memory: &noMemory}); err != nil {
				t.Fatal(err)
			}
			if _, err := m.Resume(ctx, proto.ResumeParams{SandboxID: id}, true); err != nil {
				t.Fatal(err)
			}
			if res := exec(proto.ExecParams{Command: "cat /opt/kantel-test/hello.txt"}); res.Stdout != data {
				t.Errorf("after a cold boot: %q (%q)", res.Stdout, res.Stderr)
			}
		})
	}
}

func checkReport(t *testing.T, got *proto.GuestCapabilities, want expectation) {
	t.Helper()
	if got == nil {
		t.Fatal("no guest capabilities")
	}
	t.Logf("guest: %+v", *got)
	if !got.Agent.Injected || got.Arch != "x86_64" || got.OS.ID != want.osID || got.Init != want.init {
		t.Errorf("report: agent %+v, arch %s, os %+v, init %s; want %s, %s", got.Agent, got.Arch, got.OS, got.Init, want.osID, want.init)
	}
	if want.libc != "" && got.Libc != want.libc {
		t.Errorf("libc %s, want %s", got.Libc, want.libc)
	}
	if got.Desktop.Available != want.desktop || got.Browser.Available != want.desktop || got.Docker.Available != want.docker {
		t.Errorf("desktop %+v, browser %+v, docker %+v", got.Desktop, got.Browser, got.Docker)
	}
	if !want.desktop && got.Desktop.Reason == "" {
		t.Error("a missing desktop gives no reason")
	}
	if got.Shell == "" {
		t.Error("no shell found")
	}
}
