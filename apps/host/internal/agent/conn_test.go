package agent

import (
	"errors"
	"fmt"
	"testing"

	"github.com/coder/websocket"
)

// The control plane's refusals of a host's credential stop the daemon; any other close is retried.
func TestRevokedClose(t *testing.T) {
	for code, want := range map[websocket.StatusCode]bool{
		4003:                            true, // the gateway's own close for a wrong or revoked credential
		4401:                            true, // an upgrade refused as 401
		4403:                            true, // an upgrade refused as 403
		4404:                            false,
		4502:                            false,
		websocket.StatusGoingAway:       false,
		websocket.StatusInternalError:   false,
		websocket.StatusNormalClosure:   false,
		websocket.StatusPolicyViolation: false,
	} {
		err := fmt.Errorf("read: %w", websocket.CloseError{Code: code, Reason: "why"})
		if _, got := revokedClose(err); got != want {
			t.Errorf("close %d: revoked %v, want %v", code, got, want)
		}
	}
	if _, got := revokedClose(errors.New("connection reset")); got {
		t.Error("a dropped connection isn't a revocation")
	}
}
