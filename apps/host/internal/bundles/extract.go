package bundles

import (
	"archive/tar"
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Extract unpacks the tar at tarPath into root, for a mkfs.erofs without --tar. It keeps every file's mode (execute
// bits too) and modification time, regular files, directories, symbolic links (as they are: they resolve inside the
// sandbox) and hard links, and skips devices and FIFOs. Nothing it writes is outside root: a name with `..` is
// refused, and so is one under a symbolic link the tar made. maxBytes bounds the files' bytes, so a sparse entry can't
// fill the disk.
func Extract(tarPath, root string, maxBytes int64) error {
	f, err := os.Open(tarPath)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	tr := tar.NewReader(bufio.NewReaderSize(f, 1<<20))
	type dirMode struct {
		path string
		hdr  *tar.Header
	}
	var dirs []dirMode
	var written int64
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("the bundle isn't a tar: %w", err)
		}
		name, err := entryName(hdr.Name)
		if err != nil {
			return err
		}
		target, err := within(root, name)
		if err != nil {
			return err
		}
		if name != "" {
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
		}
		mode := os.FileMode(hdr.Mode) & os.ModePerm
		switch hdr.Typeflag {
		case tar.TypeDir:
			// Never through a symbolic link the tar made at the directory's own name: MkdirAll accepts one to an
			// existing directory, and the modes set below would then land outside root.
			if err := mkdirAt(target); err != nil {
				return fmt.Errorf("the bundle's directory %q: %w", hdr.Name, err)
			}
			// Their modes last: a directory without write permission still takes its entries first.
			dirs = append(dirs, dirMode{target, hdr})
		case tar.TypeReg, tar.TypeGNUSparse:
			// Against what is left, so a huge size (a sparse file's is its logical one) can't overflow the sum.
			if hdr.Size < 0 || hdr.Size > maxBytes-written {
				return fmt.Errorf("the bundle's files are more than %d bytes", maxBytes)
			}
			written += hdr.Size
			if err := replace(target); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
			if err != nil {
				return err
			}
			_, err = io.Copy(out, tr)
			if cerr := out.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
			if err := os.Chmod(target, mode); err != nil {
				return err
			}
			_ = os.Chtimes(target, hdr.ModTime, hdr.ModTime)
		case tar.TypeSymlink:
			if err := replace(target); err != nil {
				return err
			}
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
		case tar.TypeLink:
			srcName, err := entryName(hdr.Linkname)
			if err != nil {
				return err
			}
			src, err := within(root, srcName)
			if err != nil {
				return err
			}
			if err := replace(target); err != nil {
				return err
			}
			if err := os.Link(src, target); err != nil {
				return fmt.Errorf("the bundle's hard link %s: %w", hdr.Name, err)
			}
		default:
			// Devices and FIFOs: the mount is nodev, and a bundle is files.
		}
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		d := dirs[i]
		// Only a real directory: a later entry can't have made it anything else (replace refuses a directory), but
		// a chmod that follows a link must never be possible here.
		if info, err := os.Lstat(d.path); err != nil || !info.IsDir() {
			continue
		}
		_ = os.Chmod(d.path, os.FileMode(d.hdr.Mode)&os.ModePerm)
		_ = os.Chtimes(d.path, d.hdr.ModTime, d.hdr.ModTime)
	}
	return nil
}

// entryName is a tar entry's name relative to the bundle's root ("" for the root itself), or an error for one that
// would leave it.
func entryName(raw string) (string, error) {
	name := strings.TrimLeft(raw, "/")
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return "", fmt.Errorf("the bundle's entry %q leaves the bundle", raw)
		}
	}
	name = path.Clean("/" + name)[1:]
	return name, nil
}

// within is name's path under root, refused when one of its parent directories is a symbolic link (which could
// point outside root).
func within(root, name string) (string, error) {
	if name == "" {
		return root, nil
	}
	parts := strings.Split(name, "/")
	at := root
	for _, part := range parts[:len(parts)-1] {
		at = filepath.Join(at, part)
		info, err := os.Lstat(at)
		if errors.Is(err, os.ErrNotExist) {
			break
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("the bundle's entry %q is under a symbolic link", name)
		}
	}
	return filepath.Join(root, filepath.FromSlash(name)), nil
}

// mkdirAt makes the directory target (its parents exist), or keeps one already there. Anything else at target, a
// symbolic link above all, is refused.
func mkdirAt(target string) error {
	info, err := os.Lstat(target)
	if errors.Is(err, os.ErrNotExist) {
		return os.Mkdir(target, 0o755)
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("is a symbolic link the bundle made")
	}
	if !info.IsDir() {
		return errors.New("is a file the bundle made")
	}
	return nil
}

// replace clears the way for an entry at target: a later entry of the same name wins, as with tar itself. A
// directory there isn't replaced.
func replace(target string) error {
	info, err := os.Lstat(target)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		return fmt.Errorf("the bundle has a file and a directory at %s", target)
	}
	return os.Remove(target)
}
