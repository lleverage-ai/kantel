package guest

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestWriteHostKeyIsOpenSSHs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ssh_host_ed25519_key")
	if err := writeHostKey(path, "sbx-1"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	signer, err := ssh.ParsePrivateKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	pub, _ := os.ReadFile(path + ".pub")
	if !strings.HasPrefix(string(pub), strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))) {
		t.Fatalf("public key %q doesn't match the private key", pub)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("private key mode %v", info.Mode().Perm())
	}
	// ssh-keygen (what sshd's own checks use) reads it too, where it's installed.
	if _, err := exec.LookPath("ssh-keygen"); err == nil {
		if out, err := exec.Command("ssh-keygen", "-y", "-f", path).CombinedOutput(); err != nil {
			t.Fatalf("ssh-keygen -y: %v: %s", err, out)
		}
	}
}

func TestParseReadySkipsCommentsAndBlanks(t *testing.T) {
	got := parseReady("# what the template waits for\ndocker\n\n  desktop \n# not ssh\nbrowser\nstream\n")
	if strings.Join(got, ",") != "docker,desktop,browser,stream" {
		t.Fatalf("parseReady = %q", got)
	}
	if parseReady("") != nil {
		t.Fatal("an empty file lists nothing")
	}
}

// An identity's Env is the sandbox's whole environment: a fork given an empty one keeps none of its source's.
func TestWriteEnvReplacesTheWholeEnvironment(t *testing.T) {
	path := filepath.Join(t.TempDir(), "env")
	writeEnv(path, map[string]string{"GH_TOKEN": "kph_parent", "PLAIN": "a b"})
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), `GH_TOKEN="kph_parent"`) || !strings.Contains(string(raw), `PLAIN="a b"`) {
		t.Fatalf("env file = %q", raw)
	}
	writeEnv(path, map[string]string{"GH_TOKEN": "kph_fork"})
	raw, _ = os.ReadFile(path)
	if strings.Contains(string(raw), "kph_parent") || strings.Contains(string(raw), "PLAIN") {
		t.Fatalf("a replacement kept the source's variables: %q", raw)
	}
	writeEnv(path, map[string]string{})
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("an empty environment left the file: %v", err)
	}
	// Already gone: still none, no error.
	writeEnv(path, nil)
}

// The file the host writes into a running guest (sandbox.env) is the guest agent's own format, which commandEnv reads
// back exactly: quoted values with newlines, quotes and $ in them, in a fixed order.
func TestEnvFileContentRoundTrips(t *testing.T) {
	env := map[string]string{"B": "two\nlines", "A": `say "hi" $HOME`, "C": ""}
	content := EnvFileContent(env)
	if content != "A=\"say \\\"hi\\\" $HOME\"\nB=\"two\\nlines\"\nC=\"\"\n" {
		t.Fatalf("content = %q", content)
	}
	if EnvFileContent(nil) != "" {
		t.Fatal("an empty env has no lines")
	}
	got := map[string]string{}
	for _, line := range strings.Split(content, "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			unq, err := strconv.Unquote(v)
			if err != nil {
				t.Fatalf("%s: %v", line, err)
			}
			got[k] = unq
		}
	}
	if len(got) != len(env) || got["A"] != env["A"] || got["B"] != env["B"] || got["C"] != "" {
		t.Fatalf("read back %q", got)
	}
}
