package guest

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Uploads in parts (PUT /files/part, POST /files/complete, DELETE /files/part): a large file goes up a part at a time,
// each written at its offset into a staged file beside the destination, on the same file system, so moving it into
// place is one rename. The completing call checks the staged file's size and SHA-256 before that rename, so the path
// never holds a partial file. A refused completion, an abort, an upload left idle for UploadIdle, and every upload a
// previous run of the agent had (the sandbox restarted) are discarded. A staged file is on the sandbox's own disk, so
// it counts against it as any other file does.
//
// The agent runs as root and the directory is the sandbox user's, so a staged file is never reached by a name the
// user could have prepared: it is made new (O_EXCL, with a random name) and then only ever written, checked, given
// its mode and owner through the descriptor the agent made it with. Its name is used twice more: to rename it into
// place and to remove it, each only while the name is still that same file.

const (
	// PartMaxBytes is the most one PUT /files/part takes. The host sends far smaller pieces; this bounds a request.
	PartMaxBytes = 64 << 20
	// UploadMaxBytes is the largest file an upload in parts makes.
	UploadMaxBytes = 64 << 30
	// UploadIdle is how long an upload may go without a part before it is discarded, staged file and all.
	UploadIdle = time.Hour
	// MaxUploads is how many uploads in parts a sandbox may have under way at once: each holds a file open.
	MaxUploads = 1024
	// UploadsStateDir is where the agent records its uploads' staged files, on the sandbox's disk: what a later run
	// of the agent removes (Server.RestoreUploads).
	UploadsStateDir = "/var/lib/kantel-guest/uploads"
	// stagedInfix is in each staged file's name: ".<name>.kantel-part-<random digits>".
	stagedInfix = ".kantel-part-"
)

// uploadID is the client's name for an upload.
var uploadID = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// sha256Hex is a SHA-256 as 64 hex digits.
var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// stagedName is a staged file's base name as os.CreateTemp makes it.
var stagedName = regexp.MustCompile(`^\..+` + regexp.QuoteMeta(stagedInfix) + `[0-9]+$`)

// upload is one upload in parts of one path.
type upload struct {
	key, path string
	// mu is held shared by each part being written and exclusively while the staged file is made, checked, completed
	// or discarded, so nothing is written to it once its checks have begun.
	mu sync.RWMutex
	// Under mu: the staged file, open since it was made (nil before the first part), its name and its record's.
	f              *os.File
	staged, record string
	// Under uploads.mu: touched is its last part's time; done, that it was completed (a late part is refused); gone,
	// that it was discarded (whoever waited on mu starts again or does nothing).
	touched time.Time
	done    bool
	gone    bool
}

// uploads are the agent's uploads in parts, by path and upload ID.
type uploads struct {
	mu   sync.Mutex
	byID map[string]*upload
	once sync.Once
}

func uploadKey(path, id string) string {
	sum := sha256.Sum256([]byte(path + "\x00" + id))
	return hex.EncodeToString(sum[:16])
}

// errTooManyUploads refuses a new upload past MaxUploads.
var errTooManyUploads = fmt.Errorf("this sandbox has %d uploads in parts under way already; complete or abort some", MaxUploads)

// upload is the upload of path named id, made when create is set and it isn't known; nil when it isn't known.
func (s *Server) upload(path, id string, create bool) (*upload, error) {
	s.uploads.mu.Lock()
	defer s.uploads.mu.Unlock()
	if s.uploads.byID == nil {
		s.uploads.byID = map[string]*upload{}
	}
	key := uploadKey(path, id)
	u := s.uploads.byID[key]
	if u == nil && create {
		if len(s.uploads.byID) >= MaxUploads {
			return nil, errTooManyUploads
		}
		u = &upload{key: key, path: path, touched: time.Now()}
		s.uploads.byID[key] = u
	}
	return u, nil
}

// state is u's done and gone.
func (s *Server) state(u *upload) (done, gone bool) {
	s.uploads.mu.Lock()
	defer s.uploads.mu.Unlock()
	return u.done, u.gone
}

// stage makes u's staged file beside its path and records it. The caller holds u.mu exclusively. On failure nothing
// is left, so the next part tries again.
func (s *Server) stage(u *upload) error {
	f, err := os.CreateTemp(filepath.Dir(u.path), "."+filepath.Base(u.path)+stagedInfix+"*")
	if err != nil {
		return err
	}
	record := ""
	if dir := s.UploadsDir; dir != "" {
		sum := sha256.Sum256([]byte(f.Name()))
		record = filepath.Join(dir, hex.EncodeToString(sum[:16]))
		err = os.MkdirAll(dir, 0o700)
		if err == nil {
			err = os.WriteFile(record, []byte(f.Name()+"\n"), 0o600)
		}
		if err != nil {
			_ = os.Remove(record)
			_ = os.Remove(f.Name())
			f.Close()
			return err
		}
	}
	u.f, u.staged, u.record = f, f.Name(), record
	return nil
}

// sameFile reports whether name is still the file f is open on.
func sameFile(f *os.File, name string) bool {
	opened, err := f.Stat()
	if err != nil {
		return false
	}
	named, err := os.Lstat(name)
	return err == nil && os.SameFile(opened, named)
}

// discard removes u's staged file and record, and forgets u. The caller holds u.mu exclusively.
func (s *Server) discard(u *upload) {
	if u.f != nil {
		if sameFile(u.f, u.staged) {
			_ = os.Remove(u.staged)
		}
		u.f.Close()
		u.f = nil
	}
	if u.record != "" {
		_ = os.Remove(u.record)
	}
	s.forget(u, false)
}

// forget drops u from the uploads, as done (kept for UploadIdle so a late part is refused) or gone.
func (s *Server) forget(u *upload, done bool) {
	s.uploads.mu.Lock()
	defer s.uploads.mu.Unlock()
	if done {
		u.done, u.touched = true, time.Now()
		return
	}
	u.gone = true
	if s.uploads.byID[u.key] == u {
		delete(s.uploads.byID, u.key)
	}
}

// sweepUploads discards each upload idle for UploadIdle, and forgets each completed that long ago.
func (s *Server) sweepUploads(now time.Time) {
	s.uploads.mu.Lock()
	var idle []*upload
	for k, u := range s.uploads.byID {
		if now.Sub(u.touched) < UploadIdle {
			continue
		}
		if u.done {
			delete(s.uploads.byID, k)
			continue
		}
		idle = append(idle, u)
	}
	s.uploads.mu.Unlock()
	for _, u := range idle {
		// One with a part or a completion under way isn't idle.
		if !u.mu.TryLock() {
			continue
		}
		s.uploads.mu.Lock()
		stillIdle := !u.done && !u.gone && now.Sub(u.touched) >= UploadIdle
		s.uploads.mu.Unlock()
		if stillIdle {
			s.discard(u)
		}
		u.mu.Unlock()
	}
}

// RestoreUploads removes the staged file of every upload a previous run of the agent recorded (the sandbox restarted,
// so nothing will complete them), then sweeps idle uploads every minute until the agent ends.
func (s *Server) RestoreUploads() {
	if dir := s.UploadsDir; dir != "" {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			record := filepath.Join(dir, e.Name())
			if raw, err := os.ReadFile(record); err == nil {
				removeStaged(strings.TrimSpace(string(raw)))
			}
			_ = os.Remove(record)
		}
	}
	s.uploads.once.Do(func() {
		go func() {
			for now := range time.Tick(time.Minute) {
				s.sweepUploads(now)
			}
		}()
	})
}

// removeStaged removes a previous run's staged file, but only what the agent itself made one as: an absolute path
// with a staged file's name, a regular file owned by the agent's user (no one else could have made it so).
func removeStaged(name string) {
	if !filepath.IsAbs(name) || !stagedName.MatchString(filepath.Base(name)) {
		return
	}
	info, err := os.Lstat(name)
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	if st, ok := info.Sys().(*syscall.Stat_t); !ok || int(st.Uid) != os.Geteuid() {
		return
	}
	_ = os.Remove(name)
}

// uploadParams are a part's, a completion's or an abort's path and upload ID.
func uploadParams(r *http.Request) (path, id string, err error) {
	path, err = cleanPath(r.URL.Query().Get("path"))
	if err != nil {
		return "", "", err
	}
	if path == "/" {
		return "", "", errors.New("a file can't be written at /")
	}
	id = r.URL.Query().Get("upload")
	if !uploadID.MatchString(id) {
		return "", "", fmt.Errorf("upload must be 8 to 64 letters, digits, - or _, not %q", id)
	}
	return path, id, nil
}

// writePart is PUT /files/part?path=&upload=&offset=: the body written at offset into the upload's staged file,
// making it and the destination's directories. Answers {path, upload, offset, size}, size being the part's.
func (s *Server) writePart(w http.ResponseWriter, r *http.Request) {
	path, id, err := uploadParams(r)
	if err != nil {
		fail(w, 400, err)
		return
	}
	offset, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	if err != nil || offset < 0 {
		fail(w, 400, fmt.Errorf("offset must be a whole number of bytes, not %q", r.URL.Query().Get("offset")))
		return
	}
	if offset > UploadMaxBytes {
		fail(w, 400, fmt.Errorf("a file written in parts is at most %d bytes", UploadMaxBytes))
		return
	}
	uid, gid := s.owner(r.URL.Query().Get("user"))
	dirUID, dirGID := uid, gid
	if os.Geteuid() != 0 {
		dirUID, dirGID = -1, -1
	}
	if err := mkdirAllOwned(filepath.Dir(path), dirUID, dirGID); err != nil {
		fail(w, statusOfWrite(err), err)
		return
	}
	// Holding u.mu shared, with its staged file made: made first, exclusively, if this is its first part.
	var u *upload
	for {
		if u, err = s.upload(path, id, true); err != nil {
			fail(w, 409, err)
			return
		}
		u.mu.RLock()
		done, gone := s.state(u)
		if gone {
			// Discarded while this part waited: a new one starts.
			u.mu.RUnlock()
			continue
		}
		if done {
			u.mu.RUnlock()
			fail(w, 409, fmt.Errorf("upload %s of %s is already complete", id, path))
			return
		}
		if u.f != nil {
			break
		}
		u.mu.RUnlock()
		u.mu.Lock()
		if done, gone := s.state(u); !done && !gone && u.f == nil {
			err = s.stage(u)
		}
		u.mu.Unlock()
		if err != nil {
			fail(w, statusOfWrite(err), err)
			return
		}
	}
	defer u.mu.RUnlock()
	limit := min(int64(PartMaxBytes), UploadMaxBytes-offset)
	n, err := io.Copy(io.NewOffsetWriter(u.f, offset), io.LimitReader(r.Body, limit+1))
	s.uploads.mu.Lock()
	u.touched = time.Now()
	s.uploads.mu.Unlock()
	if err == nil && n > limit {
		fail(w, 400, fmt.Errorf("a part is at most %d bytes, and a file written in parts at most %d", PartMaxBytes, UploadMaxBytes))
		return
	}
	if err != nil {
		fail(w, statusOfWrite(err), err)
		return
	}
	writeJSON(w, 200, map[string]any{"path": path, "upload": id, "offset": offset, "size": n})
}

// completeUpload is POST /files/complete?path=&upload=&size=&sha256=&mode=: once the staged file is size bytes with
// that SHA-256, it is given mode (default 0644) and the file's owner, and renamed over path. Any other outcome discards
// the upload. Completing again answers as the first did while path still has that size and SHA-256 (409 otherwise),
// so a client that lost the answer may ask again. Answers {path, size, mode}.
func (s *Server) completeUpload(w http.ResponseWriter, r *http.Request) {
	path, id, err := uploadParams(r)
	if err != nil {
		fail(w, 400, err)
		return
	}
	q := r.URL.Query()
	size, err := strconv.ParseInt(q.Get("size"), 10, 64)
	if err != nil || size < 0 {
		fail(w, 400, fmt.Errorf("size must be a whole number of bytes, not %q", q.Get("size")))
		return
	}
	want := strings.ToLower(q.Get("sha256"))
	if !sha256Hex.MatchString(want) {
		fail(w, 400, fmt.Errorf("sha256 must be 64 hex digits, not %q", q.Get("sha256")))
		return
	}
	mode := os.FileMode(0o644)
	if raw := q.Get("mode"); raw != "" {
		n, err := strconv.ParseUint(raw, 8, 32)
		if err != nil || n > 0o777 {
			fail(w, 400, fmt.Errorf("mode must be octal permissions, such as 644, not %q", raw))
			return
		}
		mode = os.FileMode(n)
	}
	u, _ := s.upload(path, id, false)
	if held := u; held != nil {
		held.mu.Lock()
		defer held.mu.Unlock()
		if done, gone := s.state(held); done || gone || held.f == nil {
			u = nil
		}
	}
	if u == nil {
		// Completed already (an answer lost on its way), or never started, or discarded.
		if got, gotSize, current, err := fileSHA256(path); err == nil && gotSize == size && got == want {
			writeJSON(w, 200, map[string]any{"path": path, "size": size, "mode": strconv.FormatUint(uint64(current.Perm()), 8)})
			return
		}
		fail(w, 409, fmt.Errorf("no upload %s of %s: nothing was written to it, or it was discarded, or %s has changed since it was completed", id, path, path))
		return
	}
	refuse := func(status int, err error) {
		s.discard(u)
		fail(w, status, err)
	}
	got, gotSize, err := sha256Of(u.f)
	switch {
	case err != nil:
		refuse(500, err)
		return
	case gotSize != size:
		refuse(400, fmt.Errorf("the parts written come to %d bytes, not %d; the upload is discarded", gotSize, size))
		return
	case got != want:
		refuse(400, fmt.Errorf("the parts written have SHA-256 %s, not %s; the upload is discarded", got, want))
		return
	}
	uid, gid := s.owner(q.Get("user"))
	if err := u.f.Chmod(mode); err != nil {
		refuse(500, err)
		return
	}
	if os.Geteuid() == 0 {
		if err := u.f.Chown(uid, gid); err != nil {
			refuse(500, err)
			return
		}
	}
	if info, err := os.Lstat(path); err == nil && info.IsDir() {
		refuse(409, fmt.Errorf("%s is a directory; the upload is discarded", path))
		return
	}
	// Its name is still the file checked: what is renamed is what was checked.
	if !sameFile(u.f, u.staged) {
		refuse(409, fmt.Errorf("the staged file of upload %s was moved or replaced; the upload is discarded", id))
		return
	}
	if err := os.Rename(u.staged, path); err != nil {
		refuse(500, err)
		return
	}
	u.f.Close()
	u.f = nil
	if u.record != "" {
		_ = os.Remove(u.record)
	}
	s.forget(u, true)
	writeJSON(w, 200, map[string]any{"path": path, "size": size, "mode": strconv.FormatUint(uint64(mode.Perm()), 8)})
}

// abortUpload is DELETE /files/part?path=&upload=: the upload's staged file removed and the upload forgotten. One that
// isn't known (never started, completed, discarded already) is fine too.
func (s *Server) abortUpload(w http.ResponseWriter, r *http.Request) {
	path, id, err := uploadParams(r)
	if err != nil {
		fail(w, 400, err)
		return
	}
	if u, _ := s.upload(path, id, false); u != nil {
		u.mu.Lock()
		// Not one completed, nor one another call discarded while this waited (its name may be a new upload's now).
		if done, gone := s.state(u); !done && !gone {
			s.discard(u)
		}
		u.mu.Unlock()
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// sha256Of is the SHA-256 (hex) and size of what f holds, read through f.
func sha256Of(f *os.File) (string, int64, error) {
	info, err := f.Stat()
	if err != nil {
		return "", 0, err
	}
	h := sha256.New()
	n, err := io.Copy(h, io.NewSectionReader(f, 0, info.Size()))
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// fileSHA256 is the SHA-256 (hex), size and mode of the regular file at path.
func fileSHA256(path string) (string, int64, os.FileMode, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", 0, 0, err
	}
	if !info.Mode().IsRegular() {
		return "", 0, 0, fmt.Errorf("%s isn't a file", path)
	}
	sum, n, err := sha256Of(f)
	return sum, n, info.Mode(), err
}

// statusOfWrite is a failed write's status: 507 for a full disk or quota, which the host answers as capacity.
func statusOfWrite(err error) int {
	if errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT) {
		return http.StatusInsufficientStorage
	}
	return 500
}
