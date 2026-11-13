// Command wgspike is a throwaway tool for the WireGuard throughput spike (LLE-18987). It brings up in-process
// WireGuard (wireguard-go over a TUN device) or kernel WireGuard with the same keys, and measures TCP and
// HTTP/2 throughput between two hosts. It is not mesh code meant to ship.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/sys/unix"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/wgctrl"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: wgspike keygen|userspace|kernel|tcpserve|tcpsend|httpserve|httpget|mkfile|stat")
	}
	cmd, args := os.Args[1], os.Args[2:]
	switch cmd {
	case "keygen":
		keygen()
	case "userspace":
		userspace(args)
	case "kernel":
		kernel(args)
	case "tcpserve":
		tcpServe(args)
	case "tcpsend":
		tcpSend(args)
	case "httpserve":
		httpServe(args)
	case "httpget":
		httpGet(args)
	case "mkfile":
		mkfile(args)
	case "stat":
		stat()
	default:
		log.Fatalf("unknown command %q", cmd)
	}
}

// keygen prints a private key and its public key, both base64.
func keygen() {
	var priv [32]byte
	if _, err := rand.Read(priv[:]); err != nil {
		log.Fatal(err)
	}
	priv[0] &= 248
	priv[31] = (priv[31] & 127) | 64
	pub, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(base64.StdEncoding.EncodeToString(priv[:]), base64.StdEncoding.EncodeToString(pub))
}

// tunnelFlags are the settings both tunnel kinds take.
type tunnelFlags struct {
	name, priv, peerPub, endpoint, addr, allowed string
	port, mtu                                    int
}

func parseTunnel(fs *flag.FlagSet, args []string) tunnelFlags {
	var t tunnelFlags
	fs.StringVar(&t.name, "name", "wgspk0", "interface name")
	fs.StringVar(&t.priv, "priv", "", "private key, base64")
	fs.StringVar(&t.peerPub, "peer-pub", "", "peer public key, base64")
	fs.StringVar(&t.endpoint, "endpoint", "", "peer endpoint host:port")
	fs.StringVar(&t.addr, "addr", "", "interface address, CIDR")
	fs.StringVar(&t.allowed, "allowed", "", "peer allowed IP, CIDR")
	fs.IntVar(&t.port, "port", 51899, "listen port")
	fs.IntVar(&t.mtu, "mtu", 1420, "MTU")
	if err := fs.Parse(args); err != nil {
		log.Fatal(err)
	}
	if !strings.HasPrefix(t.name, "wgspk") {
		log.Fatal("interface name must start with wgspk")
	}
	return t
}

func hexKey(b64 string) string {
	b, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(b) != 32 {
		log.Fatalf("bad key %q", b64)
	}
	return hex.EncodeToString(b)
}

func run(name string, args ...string) {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		log.Fatalf("%s %v: %v: %s", name, args, err, out)
	}
}

// userspace runs wireguard-go over a TUN device until it gets SIGINT or SIGTERM.
func userspace(args []string) {
	t := parseTunnel(flag.NewFlagSet("userspace", flag.ExitOnError), args)
	dev, err := tun.CreateTUN(t.name, t.mtu)
	if err != nil {
		log.Fatal(err)
	}
	logger := device.NewLogger(device.LogLevelError, "wgspike: ")
	d := device.NewDevice(dev, conn.NewDefaultBind(), logger)
	cfg := fmt.Sprintf("private_key=%s\nlisten_port=%d\npublic_key=%s\nendpoint=%s\nallowed_ip=%s\npersistent_keepalive_interval=25\n",
		hexKey(t.priv), t.port, hexKey(t.peerPub), t.endpoint, t.allowed)
	if err := d.IpcSet(cfg); err != nil {
		log.Fatal(err)
	}
	if err := d.Up(); err != nil {
		log.Fatal(err)
	}
	run("ip", "address", "add", t.addr, "dev", t.name)
	run("ip", "link", "set", t.name, "up")
	log.Printf("userspace %s up", t.name)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-sig:
	case <-d.Wait():
	}
	d.Close()
	log.Printf("userspace %s down", t.name)
}

// kernel adds a kernel WireGuard link and configures it over netlink. With -down it deletes the link.
func kernel(args []string) {
	fs := flag.NewFlagSet("kernel", flag.ExitOnError)
	down := fs.Bool("down", false, "delete the link")
	t := parseTunnel(fs, args)
	if *down {
		run("ip", "link", "del", t.name)
		return
	}
	run("ip", "link", "add", t.name, "type", "wireguard")
	c, err := wgctrl.New()
	if err != nil {
		log.Fatal(err)
	}
	defer c.Close()
	priv, err := wgtypes.ParseKey(t.priv)
	if err != nil {
		log.Fatal(err)
	}
	pub, err := wgtypes.ParseKey(t.peerPub)
	if err != nil {
		log.Fatal(err)
	}
	ep, err := net.ResolveUDPAddr("udp", t.endpoint)
	if err != nil {
		log.Fatal(err)
	}
	_, allowed, err := net.ParseCIDR(t.allowed)
	if err != nil {
		log.Fatal(err)
	}
	keepalive := 25 * time.Second
	err = c.ConfigureDevice(t.name, wgtypes.Config{
		PrivateKey: &priv,
		ListenPort: &t.port,
		Peers: []wgtypes.PeerConfig{{
			PublicKey: pub, Endpoint: ep, AllowedIPs: []net.IPNet{*allowed},
			PersistentKeepaliveInterval: &keepalive, ReplaceAllowedIPs: true,
		}},
	})
	if err != nil {
		log.Fatal(err)
	}
	run("ip", "link", "set", t.name, "mtu", strconv.Itoa(t.mtu))
	run("ip", "address", "add", t.addr, "dev", t.name)
	run("ip", "link", "set", t.name, "up")
	log.Printf("kernel %s up", t.name)
}

// tcpServe takes connections, discards what they send, and answers each with the byte count once the sender
// half-closes.
func tcpServe(args []string) {
	fs := flag.NewFlagSet("tcpserve", flag.ExitOnError)
	listen := fs.String("listen", ":51899", "listen address")
	_ = fs.Parse(args)
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			log.Fatal(err)
		}
		go func(c net.Conn) {
			defer c.Close()
			n, _ := io.CopyBuffer(io.Discard, c, make([]byte, 1<<20))
			var b [8]byte
			binary.BigEndian.PutUint64(b[:], uint64(n))
			_, _ = c.Write(b[:])
		}(c)
	}
}

// tcpSend opens n streams, writes for a duration, and reports the bytes the receiver counted.
func tcpSend(args []string) {
	fs := flag.NewFlagSet("tcpsend", flag.ExitOnError)
	to := fs.String("to", "", "receiver host:port")
	streams := fs.Int("streams", 1, "parallel streams")
	dur := fs.Duration("dur", 20*time.Second, "duration")
	_ = fs.Parse(args)
	buf := make([]byte, 1<<20)
	_, _ = rand.Read(buf)
	var total atomic.Int64
	var wg sync.WaitGroup
	start := time.Now()
	deadline := start.Add(*dur)
	for i := 0; i < *streams; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := net.Dial("tcp", *to)
			if err != nil {
				log.Fatal(err)
			}
			defer c.Close()
			for time.Now().Before(deadline) {
				if _, err := c.Write(buf); err != nil {
					log.Fatal(err)
				}
			}
			_ = c.(*net.TCPConn).CloseWrite()
			var b [8]byte
			if _, err := io.ReadFull(c, b[:]); err != nil {
				log.Fatal(err)
			}
			total.Add(int64(binary.BigEndian.Uint64(b[:])))
		}()
	}
	wg.Wait()
	el := time.Since(start).Seconds()
	report(map[string]any{"bytes": total.Load(), "seconds": el, "gbps": float64(total.Load()) * 8 / el / 1e9, "cpu": selfCPU()})
}

// httpServe serves one file over HTTP/2 without TLS (WireGuard does the encryption). Before each request
// that starts at offset 0 it drops the file from the page cache, so every download reads from disk.
func httpServe(args []string) {
	fs := flag.NewFlagSet("httpserve", flag.ExitOnError)
	listen := fs.String("listen", ":51899", "listen address")
	path := fs.String("file", "", "file to serve")
	_ = fs.Parse(args)
	mux := http.NewServeMux()
	mux.HandleFunc("/drop", func(w http.ResponseWriter, r *http.Request) {
		f, err := os.Open(*path)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer f.Close()
		if err := unix.Fadvise(int(f.Fd()), 0, 0, unix.FADV_DONTNEED); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		fmt.Fprintln(w, "dropped")
	})
	mux.HandleFunc("/file", func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, *path) })
	var p http.Protocols
	p.SetUnencryptedHTTP2(true)
	srv := &http.Server{Addr: *listen, Handler: mux, Protocols: &p}
	log.Fatal(srv.ListenAndServe())
}

// httpGet drops the server's cache of the file, then downloads it over one HTTP/2 connection as ranges of
// `chunk` bytes with `par` requests in flight, discarding the body.
func httpGet(args []string) {
	fs := flag.NewFlagSet("httpget", flag.ExitOnError)
	base := fs.String("url", "", "server base URL")
	par := fs.Int("par", 8, "requests in flight")
	chunk := fs.Int64("chunk", 64<<20, "range size")
	_ = fs.Parse(args)
	var p http.Protocols
	p.SetUnencryptedHTTP2(true)
	client := &http.Client{Transport: &http.Transport{Protocols: &p, MaxConnsPerHost: 1}}
	resp, err := client.Get(*base + "/drop")
	if err != nil {
		log.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	head, err := client.Head(*base + "/file")
	if err != nil {
		log.Fatal(err)
	}
	size := head.ContentLength
	proto := head.Proto
	var next, total atomic.Int64
	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < *par; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			buf := make([]byte, 1<<20)
			for {
				off := next.Add(*chunk) - *chunk
				if off >= size {
					return
				}
				end := min(off+*chunk, size) - 1
				req, _ := http.NewRequestWithContext(context.Background(), "GET", *base+"/file", nil)
				req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", off, end))
				r, err := client.Do(req)
				if err != nil {
					log.Fatal(err)
				}
				n, err := io.CopyBuffer(io.Discard, r.Body, buf)
				r.Body.Close()
				if err != nil || r.StatusCode != http.StatusPartialContent || n != end-off+1 {
					log.Fatalf("range %d-%d: status %d, %d bytes, %v", off, end, r.StatusCode, n, err)
				}
				total.Add(n)
			}
		}()
	}
	wg.Wait()
	el := time.Since(start).Seconds()
	report(map[string]any{"bytes": total.Load(), "seconds": el, "gbps": float64(total.Load()) * 8 / el / 1e9, "proto": proto, "cpu": selfCPU()})
}

// mkfile writes a file of random data, size in GiB.
func mkfile(args []string) {
	fs := flag.NewFlagSet("mkfile", flag.ExitOnError)
	path := fs.String("file", "", "path")
	gib := fs.Int("gib", 20, "size in GiB")
	_ = fs.Parse(args)
	f, err := os.OpenFile(*path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		log.Fatal(err)
	}
	w := bufio.NewWriterSize(f, 4<<20)
	buf := make([]byte, 4<<20)
	for i := 0; i < *gib*256; i++ {
		_, _ = rand.Read(buf)
		if _, err := w.Write(buf); err != nil {
			log.Fatal(err)
		}
	}
	if err := w.Flush(); err != nil {
		log.Fatal(err)
	}
	if err := f.Sync(); err != nil {
		log.Fatal(err)
	}
	_ = unix.Fadvise(int(f.Fd()), 0, 0, unix.FADV_DONTNEED)
	f.Close()
}

// stat prints the CPU jiffies, load average and whether CI jobs are running, for working out CPU use between
// two calls.
func stat() {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		log.Fatal(err)
	}
	fields := strings.Fields(strings.SplitN(string(b), "\n", 2)[0])[1:]
	var busy, all int64
	for i, f := range fields {
		v, _ := strconv.ParseInt(f, 10, 64)
		if i >= 8 { // guest time is already counted in user
			continue
		}
		all += v
		if i != 3 && i != 4 { // idle, iowait
			busy += v
		}
	}
	var irq int64
	for _, i := range []int{5, 6} { // irq, softirq
		v, _ := strconv.ParseInt(fields[i], 10, 64)
		irq += v
	}
	load, _ := os.ReadFile("/proc/loadavg")
	jobs := 0
	// procs is the CPU ticks of the processes the tunnel's work can be charged to: this tool's processes
	// (wireguard-go's crypto, the test traffic) and the kernel's worker and softirq threads (kernel
	// WireGuard's crypto).
	procs := map[string]int64{}
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		c, err := os.ReadFile("/proc/" + e.Name() + "/comm")
		if err != nil {
			continue
		}
		comm := strings.TrimSpace(string(c))
		if comm == "Runner.Worker" {
			jobs++
		}
		cmdline, _ := os.ReadFile("/proc/" + e.Name() + "/cmdline")
		if !strings.HasPrefix(comm, "kworker") && !strings.HasPrefix(comm, "ksoftirqd") &&
			!strings.HasPrefix(string(cmdline), "/root/wg-spike/wgspike\x00") {
			continue
		}
		if strings.Contains(string(cmdline), "\x00stat") {
			continue
		}
		s, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		f := strings.Fields(string(s[strings.LastIndexByte(string(s), ')')+2:]))
		ut, _ := strconv.ParseInt(f[11], 10, 64)
		st, _ := strconv.ParseInt(f[12], 10, 64)
		procs[e.Name()] = ut + st
	}
	report(map[string]any{"busy": busy, "all": all, "irq": irq, "procs": procs, "ncpu": numCPU(),
		"load": strings.Fields(string(load))[0], "jobs": jobs})
}

// selfCPU is the CPU seconds this process has used, user and system.
func selfCPU() float64 {
	var ru unix.Rusage
	_ = unix.Getrusage(unix.RUSAGE_SELF, &ru)
	return float64(ru.Utime.Nano()+ru.Stime.Nano()) / 1e9
}

func numCPU() int {
	var s unix.CPUSet
	_ = unix.SchedGetaffinity(0, &s)
	return s.Count()
}

func report(v map[string]any) {
	b, _ := json.Marshal(v)
	fmt.Println(string(b))
}
