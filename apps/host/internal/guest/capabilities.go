package guest

import (
	"bufio"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Detect reports what the image under root has (root is "/" in a guest; a test's directory otherwise). It only reads
// files, so it is the same whether or not the services have started yet: what it says is what the image can run.
// pid1 is "systemd" or "kantel"; injected says Kantel put the agent in.
func Detect(root, version, pid1 string, injected bool) proto.GuestCapabilities {
	var c proto.GuestCapabilities
	c.ReportedAt = time.Now().UnixMilli()
	c.Agent.Version = version
	c.Agent.Injected = injected
	c.OS.ID, c.OS.Name, c.OS.Version = osRelease(root)
	c.Arch = machine()
	c.Libc = libc(root)
	c.Shell = Shell(root)
	c.Init = pid1
	systemd := pid1 == "systemd"

	// The console's desktop is Kantel's: TigerVNC and XFCE behind Selkies, started by kantel-desktop's unit.
	if !exists(root, "/usr/local/bin/kantel-desktop") || !unitExists(root, "kantel-desktop.service") {
		c.Desktop.Reason = "No desktop in this image"
		if found := firstOf(root, "Xtigervnc", "Xvnc", "Xorg", "xfce4-session"); found != "" {
			c.Desktop.Reason = "No Kantel desktop service in this image (it has " + found + ")"
		}
	} else if !systemd {
		c.Desktop.Reason = "The desktop needs systemd in the image"
	} else {
		c.Desktop.Available = true
		c.Desktop.Detail = strings.Join(found(root, "Xtigervnc", "xfce4-session", "selkies"), ", ")
	}

	// The browser is Chromium on a display of its own (kantel-browser-display), or on the desktop: in an image from
	// before it, one that puts it back (KANTEL_BROWSER_DISPLAY=:1), or on a host that doesn't boot the guest with
	// kantel.browser=surface (one from before it, which would drop this report).
	chromium := firstOf(root, "chromium", "chromium-browser", "google-chrome", "chrome")
	ownDisplay := exists(root, "/usr/local/bin/kantel-browser-display") && unitExists(root, "kantel-browser-display.service") &&
		browserDisplay(root) == ":2"
	switch {
	case chromium == "":
		c.Browser.Reason = "No browser in this image"
	case !exists(root, "/usr/local/bin/kantel-browser") || !unitExists(root, "kantel-browser.service"):
		c.Browser.Reason = "No Kantel browser service in this image (it has " + chromium + ")"
	case !systemd:
		c.Browser.Reason = "The browser needs systemd in the image"
	case !ownDisplay && !c.Desktop.Available:
		c.Browser.Reason = "The browser needs the desktop"
	default:
		c.Browser.Available = true
		c.Browser.Detail = titleCase(chromium)
	}

	// The browser alone, streamed apart from the desktop: its display, and a stream of it (started on demand).
	switch {
	case !c.Browser.Available:
		c.BrowserSurface.Reason = "No browser in this image to show"
		if c.Browser.Reason != "" {
			c.BrowserSurface.Reason = c.Browser.Reason
		}
	case !ownDisplay:
		c.BrowserSurface.Reason = "The image runs its browser on the desktop"
	case !exists(root, "/usr/local/bin/kantel-browser-stream") || !unitExists(root, "kantel-browser-stream.service") ||
		lookPath(root, "selkies") == "":
		c.BrowserSurface.Reason = "No stream of the browser's display in this image"
	default:
		c.BrowserSurface.Available = true
		c.BrowserSurface.Detail = strings.Join(append(found(root, "Xtigervnc"), "Selkies"), ", ")
	}

	dockerd := firstOf(root, "dockerd")
	switch {
	case dockerd == "":
		c.Docker.Reason = "No Docker in this image"
	case !systemd:
		c.Docker.Reason = "Docker needs systemd in the image to start"
	default:
		c.Docker.Available = true
		c.Docker.Detail = "dockerd"
	}
	if f, err := os.OpenFile(filepath.Join(root, "/dev/kvm"), os.O_RDWR, 0); err == nil {
		f.Close()
		c.Docker.KVM = true
	}
	return c
}

// BrowserSurfaceBootArg on the guest's kernel command line is the host saying it forwards BrowserSurface: Kantel's
// image then runs Chromium on its own display (kantel-browser, and the display's and stream's units' condition).
const BrowserSurfaceBootArg = "kantel.browser=surface"

// browserDisplay is the X display the image's browser runs on, as kantel-browser chooses it: the desktop's (:1) when
// /etc/kantel/desktop.env has KANTEL_BROWSER_DISPLAY=:1 (no other value moves it), else its own (:2) when the host
// booted the guest with BrowserSurfaceBootArg, else the desktop's.
func browserDisplay(root string) string {
	if raw, err := os.ReadFile(filepath.Join(root, "/etc/kantel/desktop.env")); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
			if ok && strings.TrimSpace(strings.TrimPrefix(k, "export ")) == "KANTEL_BROWSER_DISPLAY" &&
				strings.Trim(strings.TrimSpace(v), `"'`) == ":1" {
				return ":1"
			}
		}
	}
	if bootedWith(root, BrowserSurfaceBootArg) {
		return ":2"
	}
	return ":1"
}

// bootedWith says whether the guest's kernel command line has arg, a whole word of it.
func bootedWith(root, arg string) bool {
	cmdline, err := os.ReadFile(filepath.Join(root, "/proc/cmdline"))
	return err == nil && slices.Contains(strings.Fields(string(cmdline)), arg)
}

// osRelease reads ID, PRETTY_NAME and VERSION_ID from os-release.
func osRelease(root string) (id, name, version string) {
	for _, path := range []string{"/etc/os-release", "/usr/lib/os-release"} {
		f, err := os.Open(filepath.Join(root, path))
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			k, v, ok := strings.Cut(strings.TrimSpace(scanner.Text()), "=")
			if !ok {
				continue
			}
			v = strings.Trim(v, `"'`)
			switch k {
			case "ID":
				id = v
			case "PRETTY_NAME":
				name = v
			case "NAME":
				if name == "" {
					name = v
				}
			case "VERSION_ID":
				version = v
			}
		}
		f.Close()
		break
	}
	if id == "" {
		// busybox's image has no os-release.
		if exists(root, "/bin/busybox") {
			id, name = "busybox", "BusyBox"
		} else {
			id, name = "linux", "Linux"
		}
	}
	if name == "" {
		name = id
	}
	return id, name, version
}

// machine is uname -m's name for the architecture the agent was built for, which is the guest's.
func machine() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "aarch64"
	}
	return runtime.GOARCH
}

// libc tells glibc from musl by the dynamic loader the image has; neither is a static userland (busybox's).
func libc(root string) string {
	for _, pattern := range []string{"/lib/ld-musl-*.so.1", "/usr/lib/ld-musl-*.so.1"} {
		if m, _ := filepath.Glob(filepath.Join(root, pattern)); len(m) > 0 {
			return "musl"
		}
	}
	for _, pattern := range []string{"/lib*/ld-linux*.so.*", "/usr/lib*/ld-linux*.so.*", "/lib/*-linux-gnu/libc.so.6", "/usr/lib/*-linux-gnu/libc.so.6", "/lib*/libc.so.6", "/usr/lib*/libc.so.6"} {
		if m, _ := filepath.Glob(filepath.Join(root, pattern)); len(m) > 0 {
			return "glibc"
		}
	}
	return "none"
}

// Shell is the shell a command string runs in: bash where the image has it, else sh; "" when it has neither.
func Shell(root string) string {
	for _, sh := range []string{"/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"} {
		if executable(root, sh) {
			return sh
		}
	}
	return ""
}

var binDirs = []string{"/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin", "/usr/lib/chromium", "/opt/google/chrome"}

// found lists which of names are programs in the image.
func found(root string, names ...string) []string {
	var out []string
	for _, name := range names {
		if lookPath(root, name) != "" {
			out = append(out, titleCase(name))
		}
	}
	return out
}

func firstOf(root string, names ...string) string {
	for _, name := range names {
		if lookPath(root, name) != "" {
			return name
		}
	}
	return ""
}

func lookPath(root, name string) string {
	for _, dir := range binDirs {
		if executable(root, filepath.Join(dir, name)) {
			return filepath.Join(dir, name)
		}
	}
	return ""
}

// executable follows symlinks within root (an absolute link, such as busybox's, is the image's own path).
func executable(root, path string) bool {
	for range 8 {
		full := filepath.Join(root, path)
		info, err := os.Lstat(full)
		if err != nil {
			return false
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
		}
		target, err := os.Readlink(full)
		if err != nil {
			return false
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(path), target)
		}
		path = target
	}
	return false
}

func exists(root, path string) bool {
	_, err := os.Stat(filepath.Join(root, path))
	return err == nil
}

func unitExists(root, unit string) bool {
	for _, dir := range []string{"/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"} {
		if exists(root, filepath.Join(dir, unit)) {
			return true
		}
	}
	return false
}

func titleCase(name string) string {
	switch name {
	case "selkies":
		return "Selkies"
	case "chromium", "chromium-browser":
		return "Chromium"
	case "google-chrome", "chrome":
		return "Chrome"
	}
	return name
}
