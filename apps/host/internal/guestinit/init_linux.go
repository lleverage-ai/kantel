package guestinit

import (
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// Where the agent lives in the image it boots (guest.InjectedBin), and its unit for an image's systemd.
const (
	injectedDir = "/.kantel"
	injectedBin = injectedDir + "/bin"
	agentPath   = injectedBin + "/kantel-guest"
	unitName    = "kantel-guest.service"
)

// Stage1 is the initramfs's /init: it mounts the sandbox's root, puts the agent in, and hands over to the image's
// systemd or to Stage2. It returns only when something failed (and the kernel then panics, which stops the VM).
func Stage1() error {
	log.SetFlags(0)
	log.SetPrefix("kantel-init: ")
	if err := unix.Mount("devtmpfs", "/dev", "devtmpfs", 0, ""); err != nil && !errors.Is(err, unix.EBUSY) {
		return fmt.Errorf("mount /dev: %w", err)
	}
	if err := unix.Mount("proc", "/proc", "proc", 0, ""); err != nil {
		return fmt.Errorf("mount /proc: %w", err)
	}
	// The image: read-only, whatever file system it was made as.
	var lowerErr error
	for _, fstype := range []string{"ext4", "squashfs", "erofs"} {
		if lowerErr = unix.Mount("/dev/vda", "/lower", fstype, unix.MS_RDONLY, ""); lowerErr == nil {
			break
		}
	}
	if lowerErr != nil {
		return fmt.Errorf("mount the image (/dev/vda): %w", lowerErr)
	}
	// The sandbox's own disk, laid out as the image path's kantel-init lays it out, so a disk is the same either way.
	if err := unix.Mount("/dev/vdb", "/disk", "ext4", unix.MS_NOATIME, "discard"); err != nil {
		return fmt.Errorf("mount the disk (/dev/vdb): %w", err)
	}
	for _, d := range []string{"root", "work", "docker", "containerd"} {
		if err := os.MkdirAll("/disk/"+d, 0o755); err != nil {
			return err
		}
	}
	if err := unix.Mount("overlay", "/newroot", "overlay", 0, "lowerdir=/lower,upperdir=/disk/root,workdir=/disk/work"); err != nil {
		return fmt.Errorf("mount the overlay: %w", err)
	}
	for _, d := range []string{"var/lib/docker", "var/lib/containerd", "disk", "dev", "proc", "sys", "run", "tmp", strings.TrimPrefix(injectedDir, "/")} {
		_ = os.MkdirAll(filepath.Join("/newroot", d), 0o755)
	}
	_ = os.Chmod("/newroot/tmp", 0o777|os.ModeSticky)
	if err := unix.Mount("/disk/docker", "/newroot/var/lib/docker", "", unix.MS_BIND, ""); err != nil {
		return fmt.Errorf("bind docker: %w", err)
	}
	if err := unix.Mount("/disk/containerd", "/newroot/var/lib/containerd", "", unix.MS_BIND, ""); err != nil {
		return fmt.Errorf("bind containerd: %w", err)
	}
	if err := unix.Mount("/disk", "/newroot/disk", "", unix.MS_MOVE, ""); err != nil {
		return fmt.Errorf("move /disk: %w", err)
	}
	if err := inject("/newroot"); err != nil {
		return fmt.Errorf("inject the agent: %w", err)
	}
	systemd := SystemdPath("/newroot")
	if systemd != "" {
		// /run, a tmpfs mounted here, which systemd keeps (it mounts only what isn't mounted): the agent's unit goes in
		// its runtime units, which last this boot only, so nothing on the sandbox's disk needs /.kantel, which a boot
		// without the initramfs doesn't have.
		if err := unix.Mount("tmpfs", "/newroot/run", "tmpfs", unix.MS_NOSUID|unix.MS_NODEV, "mode=0755"); err != nil {
			return fmt.Errorf("mount /run: %w", err)
		}
		if err := WriteUnit("/newroot"); err != nil {
			return fmt.Errorf("agent unit: %w", err)
		}
	}
	_ = unix.Unmount("/proc", unix.MNT_DETACH)
	if err := unix.Mount("/dev", "/newroot/dev", "", unix.MS_MOVE, ""); err != nil {
		return fmt.Errorf("move /dev: %w", err)
	}
	// The initramfs's own copy, freed once this process execs (switch_root does the same).
	_ = os.Remove("/init")
	if err := unix.Chdir("/newroot"); err != nil {
		return err
	}
	if err := unix.Mount(".", "/", "", unix.MS_MOVE, ""); err != nil {
		return fmt.Errorf("switch root: %w", err)
	}
	if err := unix.Chroot("."); err != nil {
		return fmt.Errorf("chroot: %w", err)
	}
	if err := unix.Chdir("/"); err != nil {
		return err
	}
	env := []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "TERM=linux"}
	if systemd != "" {
		return unix.Exec(systemd, []string{"/sbin/init"}, env)
	}
	return unix.Exec(agentPath, []string{"kantel-init", "init", "--stage2"}, env)
}

// inject mounts a tmpfs at root's /.kantel and copies the running agent (/init) into its bin.
func inject(root string) error {
	dir := filepath.Join(root, injectedDir)
	if err := unix.Mount("tmpfs", dir, "tmpfs", unix.MS_NOSUID|unix.MS_NODEV, "mode=0755,size=64m"); err != nil {
		return err
	}
	bin := filepath.Join(root, injectedBin)
	if err := os.MkdirAll(bin, 0o755); err != nil {
		return err
	}
	src, err := os.Open("/proc/self/exe")
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(filepath.Join(root, agentPath), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		return err
	}
	if err := dst.Close(); err != nil {
		return err
	}
	return os.Symlink("kantel-guest", filepath.Join(bin, "kantel-doctor"))
}

// SystemdPath is the image's systemd, which /sbin/init resolves to, or "" when its init is something else (or
// it has none).
func SystemdPath(root string) string {
	path := "/sbin/init"
	for range 8 {
		info, err := os.Lstat(filepath.Join(root, path))
		if err != nil {
			break
		}
		if info.Mode()&os.ModeSymlink == 0 {
			if filepath.Base(path) == "systemd" {
				return path
			}
			break
		}
		target, err := os.Readlink(filepath.Join(root, path))
		if err != nil {
			break
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(path), target)
		}
		path = target
	}
	if _, err := os.Lstat(filepath.Join(root, "/sbin/init")); err != nil {
		// No /sbin/init at all: systemd installed without systemd-sysv.
		for _, p := range []string{"/usr/lib/systemd/systemd", "/lib/systemd/systemd"} {
			if info, err := os.Stat(filepath.Join(root, p)); err == nil && info.Mode().IsRegular() {
				return p
			}
		}
	}
	return ""
}

// unit starts the injected agent early, as the image path's own kantel-guest.service does.
const unit = `# Written at each boot by Kantel's initramfs (kantel-guest init): the guest agent it put in /.kantel.
[Unit]
Description=Kantel guest agent (injected): commands, files, ports and SSH for the host, over vsock
DefaultDependencies=no
After=local-fs.target
Before=sysinit.target

[Service]
ExecStart=` + agentPath + ` serve --injected --init systemd
Restart=always
RestartSec=200ms
OOMScoreAdjust=-1000
OOMPolicy=continue

[Install]
WantedBy=sysinit.target
`

// dropIn replaces the ExecStart of an image's own kantel-guest.service (Kantel's base image), so only one agent
// listens on the vsock port, and it's the injected one.
const dropIn = `# Written at each boot by Kantel's initramfs (kantel-guest init).
[Service]
ExecStart=
ExecStart=` + agentPath + ` serve --injected --init systemd
# Commands run in the agent's cgroup: one the kernel kills for memory mustn't stop the agent and all the others.
OOMPolicy=continue
`

// WriteUnit makes root's systemd start the injected agent, for this boot only: in its runtime units
// (/run/systemd/system), a drop-in over the image's own unit when it has one, else a unit of its own, wanted by
// sysinit.target. Nothing is written to the image's /etc.
func WriteUnit(root string) error {
	run := filepath.Join(root, "run/systemd/system")
	for _, dir := range []string{"/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"} {
		if _, err := os.Stat(filepath.Join(root, dir, unitName)); err == nil {
			d := filepath.Join(run, unitName+".d")
			if err := os.MkdirAll(d, 0o755); err != nil {
				return err
			}
			return os.WriteFile(filepath.Join(d, "50-kantel-injected.conf"), []byte(dropIn), 0o644)
		}
	}
	wants := filepath.Join(run, "sysinit.target.wants")
	if err := os.MkdirAll(wants, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(run, unitName), []byte(unit), 0o644); err != nil {
		return err
	}
	link := filepath.Join(wants, unitName)
	_ = os.Remove(link)
	return os.Symlink("/run/systemd/system/"+unitName, link)
}

// Stage2 is PID 1 in an image without systemd: it mounts what a Linux userland expects, runs the agent (again
// whenever it exits), reaps every orphan, and on Ctrl-Alt-Del (the host's stop) ends every process and stops the VM.
func Stage2() error {
	log.SetFlags(0)
	log.SetPrefix("kantel-init: ")
	const fixed = unix.MS_NOSUID | unix.MS_NOEXEC | unix.MS_NODEV
	mounts := []struct {
		source, target, fstype string
		flags                  uintptr
		data                   string
	}{
		{"proc", "/proc", "proc", fixed, ""},
		{"sysfs", "/sys", "sysfs", fixed, ""},
		{"devpts", "/dev/pts", "devpts", unix.MS_NOSUID | unix.MS_NOEXEC, "mode=0620,ptmxmode=0666,gid=5"},
		{"tmpfs", "/dev/shm", "tmpfs", unix.MS_NOSUID | unix.MS_NODEV, "mode=1777"},
		{"tmpfs", "/run", "tmpfs", unix.MS_NOSUID | unix.MS_NODEV, "mode=0755"},
		{"cgroup2", "/sys/fs/cgroup", "cgroup2", fixed, ""},
	}
	for _, m := range mounts {
		_ = os.MkdirAll(m.target, 0o755)
		if err := unix.Mount(m.source, m.target, m.fstype, m.flags, m.data); err != nil && !errors.Is(err, unix.EBUSY) {
			log.Printf("mount %s: %v", m.target, err)
		}
	}
	if _, err := os.Lstat("/dev/fd"); err != nil {
		_ = os.Symlink("/proc/self/fd", "/dev/fd")
	}
	_ = unix.Sethostname([]byte("kantel"))
	if err := linkUp("lo"); err != nil {
		log.Printf("lo: %v", err)
	}
	// Ctrl-Alt-Del comes to PID 1 as SIGINT, rather than rebooting at once.
	_ = unix.Reboot(unix.LINUX_REBOOT_CMD_CAD_OFF)
	signals := make(chan os.Signal, 16)
	signal.Notify(signals, unix.SIGCHLD, unix.SIGINT, unix.SIGTERM, unix.SIGPWR)
	agent := startAgent()
	for sig := range signals {
		if sig != unix.SIGCHLD {
			shutdown()
		}
		for {
			var status unix.WaitStatus
			pid, err := unix.Wait4(-1, &status, unix.WNOHANG, nil)
			if pid <= 0 || err != nil {
				break
			}
			if agent != nil && pid == agent.Process.Pid {
				log.Printf("agent exited (%v); starting it again", status)
				time.Sleep(200 * time.Millisecond)
				agent = startAgent()
			}
		}
	}
	return nil
}

// startAgent runs the agent as PID 1's child; PID 1 reaps it with everything else (so never cmd.Wait).
func startAgent() *exec.Cmd {
	cmd := exec.Command(agentPath, "serve", "--injected", "--init", "kantel")
	cmd.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:" + injectedBin}
	cmd.Dir = "/"
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Start(); err != nil {
		log.Printf("start the agent: %v", err)
		return nil
	}
	return cmd
}

// shutdown ends every process (TERM, then KILL after three seconds), syncs, and stops the VM (reboot=k makes
// Firecracker exit on a reboot).
func shutdown() {
	_ = unix.Kill(-1, unix.SIGTERM)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var status unix.WaitStatus
		if pid, err := unix.Wait4(-1, &status, unix.WNOHANG, nil); err == unix.ECHILD {
			break
		} else if pid <= 0 {
			time.Sleep(50 * time.Millisecond)
		}
	}
	_ = unix.Kill(-1, unix.SIGKILL)
	unix.Sync()
	_ = unix.Reboot(unix.LINUX_REBOOT_CMD_RESTART)
	os.Exit(0)
}

// linkUp sets an interface up; guest.LinkUp's twin, so this package needs nothing of the agent's.
func linkUp(name string) error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	ifr, err := unix.NewIfreq(name)
	if err != nil {
		return err
	}
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, ifr); err != nil {
		return err
	}
	ifr.SetUint16(ifr.Uint16() | unix.IFF_UP)
	return unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, ifr)
}
