package guest

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The host stops waiting for a trim after a while, but the guest's ioctl runs on: a trim asked for meanwhile answers
// 409 at once rather than start a second one or queue behind the first.
func TestTrimDiskOneAtATime(t *testing.T) {
	s := &Server{}
	s.trimming.Lock()
	defer s.trimming.Unlock()
	rec := httptest.NewRecorder()
	s.trimDisk(rec, httptest.NewRequest(http.MethodPost, "/disk/trim", nil))
	if rec.Code != http.StatusConflict {
		t.Fatalf("a trim beside a running one answered %d: %s", rec.Code, rec.Body.String())
	}
}
