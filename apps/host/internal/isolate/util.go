package isolate

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os/exec"
	"strings"
)

func runCmd(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v: %s", name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func entropy() string {
	buf := make([]byte, 64)
	_, _ = rand.Read(buf)
	return base64.StdEncoding.EncodeToString(buf)
}
