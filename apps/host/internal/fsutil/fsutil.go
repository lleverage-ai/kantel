// Package fsutil holds the host's file writes that must survive a crash.
package fsutil

import (
	"errors"
	"os"
	"path/filepath"
)

// WriteFileDurably replaces path with data atomically and durably: a temporary file beside it is written and synced,
// renamed over it, and then the directory is synced, so after a crash path holds either the old data or the new,
// and once it returns, the new. The directory must exist.
func WriteFileDurably(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	_, werr := f.Write(data)
	serr := f.Sync()
	cerr := f.Close()
	if err := errors.Join(werr, serr, cerr); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	serr = d.Sync()
	cerr = d.Close()
	return errors.Join(serr, cerr)
}
