package guest

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// OnDemandFile lists the image's services that run only while something uses their port: the agent starts one when
// the host opens its port and nothing answers, and stops it once nothing has been connected to the port for its idle
// time. One per line, `<port> <unit> [<idle>]` (a Go duration, default DefaultOnDemandIdle; 0 never stops it); blank
// lines and # comments are skipped. Kantel's image lists the browser's stream (6081), whose encoder then costs nothing
// while nobody watches.
const OnDemandFile = "/etc/kantel/on-demand"

// DefaultOnDemandIdle is how long an on-demand service runs with nothing connected before it is stopped.
const DefaultOnDemandIdle = 5 * time.Minute

// onDemandStartTimeout bounds a start: the unit's own ready check (the browser stream's waits for Selkies' port).
const onDemandStartTimeout = 60 * time.Second

type onDemandService struct {
	Unit string
	Idle time.Duration
}

// parseOnDemand reads an OnDemandFile; a line it can't read is skipped.
func parseOnDemand(raw string) map[int]onDemandService {
	services := map[int]onDemandService{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 || len(fields) > 3 {
			continue
		}
		port, err := strconv.Atoi(fields[0])
		if err != nil || port <= 0 || port > 65535 || !strings.HasSuffix(fields[1], ".service") {
			continue
		}
		idle := DefaultOnDemandIdle
		if len(fields) == 3 {
			if idle, err = time.ParseDuration(fields[2]); err != nil || idle < 0 {
				continue
			}
		}
		services[port] = onDemandService{Unit: fields[1], Idle: idle}
	}
	return services
}

// onDemand starts and stops the on-demand services, counting the connections to each one's port.
type onDemand struct {
	services map[int]onDemandService
	start    func(ctx context.Context, unit string) error
	stop     func(ctx context.Context, unit string) error

	mu sync.Mutex
	// life serialises a port's start, its first connection and its stop, so a connection never reaches a service
	// being stopped.
	life map[int]*sync.Mutex
	open map[int]int
	// gen changes with every connection opened or closed, so an idle timer set before one does nothing.
	gen    map[int]uint64
	timers map[int]*time.Timer
}

func newOnDemand(services map[int]onDemandService, start, stop func(ctx context.Context, unit string) error) *onDemand {
	d := &onDemand{
		services: services,
		start:    start,
		stop:     stop,
		life:     map[int]*sync.Mutex{},
		open:     map[int]int{},
		gen:      map[int]uint64{},
		timers:   map[int]*time.Timer{},
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for port := range services {
		d.life[port] = &sync.Mutex{}
		// One started before the agent (by hand, or an agent that has restarted since) stops too, once idle.
		d.idleLocked(port)
	}
	return d
}

// systemctl runs `systemctl <verb> <unit>`.
func systemctl(verb string) func(ctx context.Context, unit string) error {
	return func(ctx context.Context, unit string) error {
		out, err := exec.CommandContext(ctx, "systemctl", verb, unit).CombinedOutput()
		if err != nil {
			return fmt.Errorf("systemctl %s %s: %v: %s", verb, unit, err, strings.TrimSpace(string(out)))
		}
		return nil
	}
}

// loadOnDemand reads OnDemandFile; with none, no port is on demand.
func loadOnDemand() *onDemand {
	raw, _ := os.ReadFile(OnDemandFile)
	return newOnDemand(parseOnDemand(string(raw)), systemctl("start"), systemctl("stop"))
}

// dial connects to a port, starting its service first when it is on demand and nothing answers. done is called once
// the connection is over (it may be called more than once).
func (d *onDemand) dial(ctx context.Context, port int, connect func() (net.Conn, error)) (net.Conn, func(), error) {
	service, ok := d.services[port]
	if !ok {
		conn, err := connect()
		return conn, func() {}, err
	}
	life := d.life[port]
	life.Lock()
	defer life.Unlock()
	conn, err := connect()
	if err != nil {
		startCtx, cancel := context.WithTimeout(ctx, onDemandStartTimeout)
		err = d.start(startCtx, service.Unit)
		cancel()
		if err == nil {
			conn, err = connect()
		}
		if err != nil {
			// Started but not reached (or half started): stopped again once idle, like any other.
			d.mu.Lock()
			d.idleLocked(port)
			d.mu.Unlock()
			return nil, nil, err
		}
	}
	d.mu.Lock()
	d.open[port]++
	d.gen[port]++
	if timer := d.timers[port]; timer != nil {
		timer.Stop()
		delete(d.timers, port)
	}
	d.mu.Unlock()
	var once sync.Once
	return conn, func() { once.Do(func() { d.closed(port) }) }, nil
}

func (d *onDemand) closed(port int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.open[port]--
	d.gen[port]++
	if d.open[port] == 0 {
		d.idleLocked(port)
	}
}

// idleLocked sets the port's idle timer, with d.mu held.
func (d *onDemand) idleLocked(port int) {
	service := d.services[port]
	if service.Idle <= 0 || d.open[port] > 0 {
		return
	}
	if timer := d.timers[port]; timer != nil {
		timer.Stop()
	}
	gen := d.gen[port]
	d.timers[port] = time.AfterFunc(service.Idle, func() { d.expire(port, gen) })
}

// expire stops a port's service if nothing has connected to it since its idle timer was set.
func (d *onDemand) expire(port int, gen uint64) {
	life := d.life[port]
	life.Lock()
	defer life.Unlock()
	d.mu.Lock()
	if d.open[port] > 0 || d.gen[port] != gen {
		d.mu.Unlock()
		return
	}
	delete(d.timers, port)
	d.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), onDemandStartTimeout)
	defer cancel()
	_ = d.stop(ctx, d.services[port].Unit)
}
