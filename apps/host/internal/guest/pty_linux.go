package guest

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// foreground is the process group in the foreground of the terminal whose controlling side ptmx is, or 0.
func foreground(ptmx *os.File) int {
	raw, err := ptmx.SyscallConn()
	if err != nil {
		return 0
	}
	pgrp := 0
	_ = raw.Control(func(fd uintptr) {
		if pg, err := unix.IoctlGetInt(int(fd), unix.TIOCGPGRP); err == nil {
			pgrp = pg
		}
	})
	return pgrp
}

// openPTY opens a new pseudo-terminal pair: the controlling side (ptmx) and the terminal a shell gets (pts).
func openPTY() (ptmx, pts *os.File, err error) {
	fd, err := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("open /dev/ptmx: %w", err)
	}
	ptmx = os.NewFile(uintptr(fd), "/dev/ptmx")
	if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
		ptmx.Close()
		return nil, nil, fmt.Errorf("unlockpt: %w", err)
	}
	n, err := unix.IoctlGetUint32(fd, unix.TIOCGPTN)
	if err != nil {
		ptmx.Close()
		return nil, nil, fmt.Errorf("ptsname: %w", err)
	}
	name := fmt.Sprintf("/dev/pts/%d", n)
	pfd, err := unix.Open(name, unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		ptmx.Close()
		return nil, nil, fmt.Errorf("open %s: %w", name, err)
	}
	return ptmx, os.NewFile(uintptr(pfd), name), nil
}

func setWinsize(f *os.File, cols, rows uint32) {
	if cols == 0 || rows == 0 {
		return
	}
	_ = unix.IoctlSetWinsize(int(f.Fd()), unix.TIOCSWINSZ, &unix.Winsize{Col: uint16(cols), Row: uint16(rows)})
}
