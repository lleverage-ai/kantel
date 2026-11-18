package cli

import (
	"os/exec"
	"runtime"
	"strings"
)

// openInBrowser opens url in the person's browser, quietly doing nothing where it can't: the URL is printed anyway.
func openInBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", strings.ReplaceAll(url, "&", "^&"))
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if cmd.Start() == nil {
		go func() { _ = cmd.Wait() }()
	}
}
