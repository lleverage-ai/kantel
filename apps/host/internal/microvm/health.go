package microvm

import (
	"context"
	"fmt"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/usage"
)

// A running microVM's guest agent is asked for its health (GET /health, which answers at once) every healthInterval.
// healthMisses in a row unanswered, each given healthTimeout, mark the sandbox unresponsive: its info says so
// (SandboxInfo.Health, with HealthReason), and the control plane takes it out of running. Its next answer clears it. A
// probe that would wait on the sandbox's lock (a lifecycle call or a snapshot holds it, and may have paused the VM) is
// skipped, not counted, so a long snapshot never reads as an unresponsive guest.
var (
	healthInterval = 15 * time.Second
	healthTimeout  = 5 * time.Second
	healthMisses   = 4
	// answerTimeout bounds asking a sandbox the host has running whether its agent answers, before a start or resume
	// answers it as running (answers).
	answerTimeout = 3 * time.Second
	// stopSyncTimeout bounds the guest's sync before a stop pauses the VM: a guest that doesn't answer (out of memory,
	// say) is stopped without it, as a crash would leave its disk, rather than the stop waiting out its call.
	stopSyncTimeout = 10 * time.Second
	// outOfMemoryShare is how little of its memory a guest may have available, as its balloon last reported it, for an
	// unresponsive one to be called out of memory.
	outOfMemoryShare = 0.05
)

// healthClient is what the watch asks of a guest agent.
type healthClient interface {
	Health(ctx context.Context) (guest.Health, error)
}

// readGuestMemory is the guest's memory as its balloon last had it (guestMemory); a test stands in its own.
var readGuestMemory = guestMemory

// watchHealth asks machine's guest for its health until machine is no longer the sandbox's (it exited, or a stop,
// reset or delete let it go).
func (m *Manager) watchHealth(s *sandbox, machine *fc.Machine) {
	// As they are now, for the machine's whole run.
	interval, timeout, limit, readMemory := healthInterval, healthTimeout, healthMisses, readGuestMemory
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		misses := 0
		for {
			select {
			case <-machine.Done():
				return
			case <-ticker.C:
			}
			if m.closed.Load() {
				return
			}
			if !s.mu.TryLock() {
				continue
			}
			if s.machine != machine || s.meta.State != proto.StateRunning || s.guest == nil {
				s.mu.Unlock()
				return
			}
			var client healthClient = s.guest
			if s.probe != nil {
				client = s.probe
			}
			s.mu.Unlock()
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			_, err := client.Health(ctx)
			cancel()
			s.mu.Lock()
			if s.machine != machine {
				s.mu.Unlock()
				return
			}
			if err == nil {
				misses = 0
				if s.unresponsive != "" {
					s.unresponsive = ""
					m.log.Info("sandbox's guest agent answers again", "sandbox", s.meta.ID)
					m.emit(s)
				}
				s.mu.Unlock()
				continue
			}
			misses++
			if misses >= limit && s.unresponsive == "" {
				s.unresponsive = unresponsiveReason(readMemory, machine.Dir, time.Duration(misses)*interval)
				m.log.Warn("sandbox's guest agent doesn't answer", "sandbox", s.meta.ID, "reason", s.unresponsive, "error", err)
				m.emit(s)
			}
			s.mu.Unlock()
		}
	}()
}

// unresponsiveReason says why a sandbox is unresponsive, in words: its agent hasn't answered for about since, and,
// where its balloon's last report has next to nothing available, that it is out of memory.
func unresponsiveReason(readMemory func(context.Context, string) (usage.Memory, error), dir string, since time.Duration) string {
	reason := fmt.Sprintf("Its guest agent hasn't answered for %d seconds", int(since.Seconds()))
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	mem, err := readMemory(ctx, dir)
	if err != nil || mem.Total <= 0 {
		return reason
	}
	used := mem.Total - mem.Available
	if float64(mem.Available) <= float64(mem.Total)*outOfMemoryShare {
		return fmt.Sprintf("%s: it is out of memory (%s of %s in use). Recover it (a restart that keeps its disk), and give it more memory or run less at once", reason, gbText(used), gbText(mem.Total))
	}
	return fmt.Sprintf("%s (%s of %s memory in use). Recover it: a restart that keeps its disk", reason, gbText(used), gbText(mem.Total))
}

// gbText is bytes in gigabytes, to one decimal place.
func gbText(n int64) string {
	return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
}

// answers says whether the guest agent of s, which the host has running, answers within answerTimeout. Called with
// s.mu held.
func (m *Manager) answers(ctx context.Context, s *sandbox) bool {
	if s.unresponsive != "" || s.guest == nil {
		return false
	}
	var client healthClient = s.guest
	if s.probe != nil {
		client = s.probe
	}
	ctx, cancel := context.WithTimeout(ctx, answerTimeout)
	defer cancel()
	_, err := client.Health(ctx)
	return err == nil
}

// reset ends the VM of s, which the host has running, as a power cut would: its disk stays as it is (its journal
// replays at the next boot), its memory goes. s is stopped then, for a cold boot. Called with s.mu held.
func (m *Manager) reset(s *sandbox, why string) {
	machine := s.machine
	// Let go first, so its watch doesn't take the exit for the VM's own.
	s.machine = nil
	if s.guest != nil {
		s.guest.Close()
	}
	if machine != nil {
		machine.Kill()
	}
	if mt := m.mountsOf(s); mt != nil {
		mt.Close()
	}
	if s.link != nil {
		m.cfg.Network.Remove(*s.link)
		m.detach(s.link.Slot)
		s.link = nil
	}
	m.releaseBundles(s, nil)
	s.meta.State = proto.StateStopped
	s.meta.Memory = false
	s.meta.Pid = 0
	s.unresponsive = ""
	if err := m.writeMeta(s); err != nil {
		s.unsaved = true
	}
	m.log.Warn("reset a sandbox's VM", "sandbox", s.meta.ID, "why", why)
}
