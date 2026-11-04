package guest

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

// image lays out a fake root: files (with content) and symlinks ("->target").
func image(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for path, content := range files {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if target, ok := strings.CutPrefix(content, "->"); ok {
			if err := os.Symlink(target, full); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.WriteFile(full, []byte(content), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestDetectKantelImage(t *testing.T) {
	root := image(t, map[string]string{
		"etc/os-release":                                "ID=ubuntu\nPRETTY_NAME=\"Ubuntu 26.04.1 LTS\"\nVERSION_ID=\"26.04\"\n",
		"lib64/ld-linux-x86-64.so.2":                    "",
		"bin/bash":                                      "",
		"usr/bin/Xtigervnc":                             "",
		"usr/bin/xfce4-session":                         "",
		"usr/local/bin/selkies":                         "",
		"usr/local/bin/kantel-desktop":                  "",
		"usr/local/bin/kantel-browser":                  "",
		"usr/bin/chromium":                              "",
		"usr/bin/dockerd":                               "",
		"etc/systemd/system/kantel-desktop.service":     "",
		"usr/lib/systemd/system/kantel-browser.service": "",
	})
	c := Detect(root, "1.18.0", "systemd", true)
	if c.OS.ID != "ubuntu" || c.OS.Name != "Ubuntu 26.04.1 LTS" || c.OS.Version != "26.04" {
		t.Errorf("os: %+v", c.OS)
	}
	if c.Libc != "glibc" || c.Shell != "/bin/bash" || c.Init != "systemd" || !c.Agent.Injected || c.Agent.Version != "1.18.0" {
		t.Errorf("libc %s, shell %s, init %s, agent %+v", c.Libc, c.Shell, c.Init, c.Agent)
	}
	if !c.Desktop.Available || c.Desktop.Detail != "Xtigervnc, xfce4-session, Selkies" {
		t.Errorf("desktop: %+v", c.Desktop)
	}
	if !c.Browser.Available || c.Browser.Detail != "Chromium" {
		t.Errorf("browser: %+v", c.Browser)
	}
	if !c.Docker.Available || c.Docker.KVM {
		t.Errorf("docker: %+v", c.Docker)
	}
}

func TestDetectAlpine(t *testing.T) {
	root := image(t, map[string]string{
		"etc/os-release":          "NAME=\"Alpine Linux\"\nID=alpine\nVERSION_ID=3.22.7\nPRETTY_NAME=\"Alpine Linux v3.22\"\n",
		"lib/ld-musl-x86_64.so.1": "",
		"bin/busybox":             "",
		"bin/sh":                  "->/bin/busybox",
		"usr/bin/chromium":        "",
	})
	c := Detect(root, "1.18.0", "kantel", true)
	if c.OS.ID != "alpine" || c.Libc != "musl" || c.Shell != "/bin/sh" || c.Init != "kantel" {
		t.Errorf("%+v", c)
	}
	if c.Desktop.Available || c.Desktop.Reason != "No desktop in this image" {
		t.Errorf("desktop: %+v", c.Desktop)
	}
	// A Chromium without Kantel's service isn't offered, and says why.
	if c.Browser.Available || c.Browser.Reason != "No Kantel browser service in this image (it has chromium)" {
		t.Errorf("browser: %+v", c.Browser)
	}
	if c.Docker.Available || c.Docker.Reason != "No Docker in this image" {
		t.Errorf("docker: %+v", c.Docker)
	}
}

func TestDetectBusyboxAndBare(t *testing.T) {
	// busybox's own image: no os-release and a static userland.
	busybox := Detect(image(t, map[string]string{"bin/busybox": "", "bin/sh": "->busybox"}), "v", "kantel", true)
	if busybox.OS.ID != "busybox" || busybox.OS.Name != "BusyBox" || busybox.Libc != "none" || busybox.Shell != "/bin/sh" {
		t.Errorf("busybox: %+v", busybox)
	}
	// No shell at all: commands run only as argv.
	bare := Detect(image(t, map[string]string{"app": ""}), "v", "kantel", true)
	if bare.OS.ID != "linux" || bare.Shell != "" || bare.Libc != "none" {
		t.Errorf("bare: %+v", bare)
	}
}

func TestDetectDockerNeedsSystemd(t *testing.T) {
	root := image(t, map[string]string{
		"etc/os-release":  "ID=debian\nPRETTY_NAME=\"Debian GNU/Linux 13 (trixie)\"\nVERSION_ID=\"13\"\n",
		"usr/bin/dockerd": "",
		"usr/bin/Xorg":    "",
	})
	if c := Detect(root, "v", "kantel", true); c.Docker.Available || c.Docker.Reason != "Docker needs systemd in the image to start" {
		t.Errorf("docker without systemd: %+v", c.Docker)
	}
	c := Detect(root, "v", "systemd", true)
	if !c.Docker.Available {
		t.Errorf("docker with systemd: %+v", c.Docker)
	}
	if c.Desktop.Available || c.Desktop.Reason != "No Kantel desktop service in this image (it has Xorg)" {
		t.Errorf("a display server alone: %+v", c.Desktop)
	}
}

func TestExecutableFollowsLinksInsideRoot(t *testing.T) {
	root := image(t, map[string]string{
		"bin/busybox":  "",
		"bin/sh":       "->/bin/busybox",
		"usr/bin/env":  "->../../bin/busybox",
		"bin/dangling": "->/nowhere",
		"bin/loop":     "->/bin/loop",
	})
	if err := os.Chmod(filepath.Join(root, "bin/busybox"), 0o755); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]bool{"/bin/sh": true, "/usr/bin/env": true, "/bin/dangling": false, "/bin/loop": false, "/bin": false} {
		if got := executable(root, path); got != want {
			t.Errorf("executable(%s) = %v, want %v", path, got, want)
		}
	}
}

func TestAuthorized(t *testing.T) {
	key := func() ssh.PublicKey {
		pub, _, _ := ed25519.GenerateKey(rand.Reader)
		k, _ := ssh.NewPublicKey(pub)
		return k
	}
	yes, no, limited, forced := key(), key(), key(), key()
	path := filepath.Join(t.TempDir(), "authorized_keys")
	lines := "# a comment\n" + `restrict,command="true" ` + string(ssh.MarshalAuthorizedKey(limited)) +
		`command="/usr/bin/backup" ` + string(ssh.MarshalAuthorizedKey(forced)) + string(ssh.MarshalAuthorizedKey(yes))
	if err := os.WriteFile(path, []byte(lines), 0o600); err != nil {
		t.Fatal(err)
	}
	if !authorized(path, yes) {
		t.Error("a listed key is refused")
	}
	if authorized(path, no) {
		t.Error("an unlisted key is let in")
	}
	// Options this server doesn't enforce: such a key gets nothing, not everything.
	if authorized(path, limited) || authorized(path, forced) {
		t.Error("a key restricted by its options is let in unrestricted")
	}
	if authorized(filepath.Join(t.TempDir(), "none"), yes) {
		t.Error("no file lets a key in")
	}
}

func TestLoginShell(t *testing.T) {
	root := image(t, map[string]string{
		"bin/bash": "",
		"bin/sh":   "",
		"etc/passwd": "root:x:0:0:root:/root:/bin/bash\n" +
			"daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n" +
			"sync:x:4:65534:sync:/bin:/bin/false\n" +
			"user:x:1000:1000::/home/user:/bin/zsh\n",
	})
	for _, c := range []struct {
		name, shell string
		denied      bool
	}{
		{"root", "/bin/bash", false},
		{"daemon", "", true},
		{"sync", "", true},
		{"user", "/bin/bash", false}, // its shell isn't in the image: the image's shell
		{"nobody", "/bin/bash", false},
	} {
		sh, denied := loginShellIn(root, c.name)
		if sh != c.shell || denied != c.denied {
			t.Errorf("%s: shell %q denied %v, want %q %v", c.name, sh, denied, c.shell, c.denied)
		}
	}
	// No /etc/passwd at all (a bare image): the image's shell, never a refusal.
	if sh, denied := loginShellIn(image(t, map[string]string{"bin/sh": ""}), "root"); sh != "/bin/sh" || denied {
		t.Errorf("no passwd: %q %v", sh, denied)
	}
}
