package main

import (
	"bufio"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
)

// connect is a ProxyCommand for ssh (and anything else that speaks over a command's stdin and stdout): it opens a
// tunnel to host:port through the sandbox's egress proxy with an HTTP CONNECT, then passes bytes both ways until either
// side ends. A sandbox has no DNS and no route out but the proxy, and ssh doesn't read HTTPS_PROXY, so without it
// `ssh git@github.com` fails at the name lookup. The image's /etc/ssh/ssh_config.d/kantel.conf uses it:
//
//	Host github.com
//		HostName ssh.github.com
//		Port 443
//		ProxyCommand /usr/local/bin/kantel-connect %h %p
//
// It goes through the guest agent's forwarder (guest.LocalProxyAddr), which follows the proxy's address across forks
// and resumes and is there under sudo and in systemd units, where HTTPS_PROXY isn't. Where nothing listens there (an
// image without the agent's forwarder), it uses HTTPS_PROXY's or HTTP_PROXY's address. The user name in either, the
// sandbox's own label for its requests, goes on the CONNECT as the proxy's attribution, as curl would send it.
func connect(args []string, getenv func(string) string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		_, _ = io.WriteString(stdout, connectUsage)
		return 0
	}
	if len(args) != 2 {
		_, _ = io.WriteString(stderr, connectUsage)
		return 2
	}
	target, err := connectTarget(args[0], args[1])
	if err != nil {
		fmt.Fprintf(stderr, "kantel-connect: %v\n", err)
		return 2
	}
	conn, reader, err := openTunnel(proxyCandidates(getenv), target, 10*time.Second, 60*time.Second)
	if err != nil {
		fmt.Fprintf(stderr, "kantel-connect: %s: %v\n", target, err)
		return 1
	}
	defer conn.Close()
	go func() {
		_, _ = io.Copy(conn, stdin)
		// ssh closed its end: the far side sees the end of our stream, and closes its own when it's done.
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		} else {
			_ = conn.Close()
		}
	}()
	// The reader first: it may hold the far side's first bytes (an SSH banner), read along with the proxy's answer.
	_, _ = io.Copy(stdout, reader)
	return 0
}

const connectUsage = `usage: kantel-connect <host> <port>   (also: kantel-guest connect <host> <port>)

Opens a tunnel to host:port through the sandbox's egress proxy and passes stdin and stdout through it: ssh's
ProxyCommand, as in /etc/ssh/ssh_config.d/kantel.conf (ProxyCommand /usr/local/bin/kantel-connect %h %p).
`

// connectTarget is the CONNECT authority for a host and port as ssh's %h and %p give them. Only a host name or an IP
// address goes on the request line: nothing that could end it or add a header.
func connectTarget(host, port string) (string, error) {
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	if host == "" {
		return "", errors.New("no host")
	}
	for _, r := range host {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune(".-_:", r)) {
			return "", fmt.Errorf("%q isn't a host name or an IP address", host)
		}
	}
	if strings.Contains(host, ":") && net.ParseIP(host) == nil {
		return "", fmt.Errorf("%q isn't a host name or an IP address", host)
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", fmt.Errorf("%q isn't a port", port)
	}
	return net.JoinHostPort(host, strconv.Itoa(n)), nil
}

// localProxyAddr is the guest agent's forwarder to the egress proxy (a variable for the tests).
var localProxyAddr = guest.LocalProxyAddr

// proxyCandidate is a proxy to try, and the Proxy-Authorization to send it ("" for none).
type proxyCandidate struct{ addr, auth string }

// proxyCandidates are the proxies to try in turn: the agent's forwarder, then the environment's proxy (HTTPS_PROXY,
// then HTTP_PROXY, either case), each with the environment proxy URL's user as its attribution.
func proxyCandidates(getenv func(string) string) []proxyCandidate {
	var envAddr, auth string
	for _, name := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"} {
		raw := strings.TrimSpace(getenv(name))
		if raw == "" {
			continue
		}
		if !strings.Contains(raw, "://") {
			raw = "http://" + raw
		}
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" || u.Scheme != "http" {
			continue
		}
		envAddr = u.Host
		if u.Port() == "" {
			envAddr = net.JoinHostPort(u.Hostname(), "80")
		}
		if u.User != nil {
			password, _ := u.User.Password()
			auth = "Basic " + base64.StdEncoding.EncodeToString([]byte(u.User.Username()+":"+password))
		}
		break
	}
	out := []proxyCandidate{{addr: localProxyAddr, auth: auth}}
	if envAddr != "" && envAddr != localProxyAddr {
		out = append(out, proxyCandidate{addr: envAddr, auth: auth})
	}
	return out
}

// openTunnel sends CONNECT target to the first candidate that takes a connection, and returns the tunnel once the
// proxy answers 200, with the reader its answer was read through (which may already hold the far side's first bytes).
// A refusal comes back as an error with the proxy's reason, from its body or its status line.
func openTunnel(candidates []proxyCandidate, target string, dialTimeout, answerTimeout time.Duration) (net.Conn, *bufio.Reader, error) {
	var conn net.Conn
	var via proxyCandidate
	var dialErr error
	for _, c := range candidates {
		var err error
		conn, err = net.DialTimeout("tcp", c.addr, dialTimeout)
		if err == nil {
			via = c
			break
		}
		if dialErr == nil {
			dialErr = err
		}
		// Nothing listening is the only reason to try the next: a forwarder that's there but slow is the way out.
		if !errors.Is(err, syscall.ECONNREFUSED) {
			break
		}
	}
	if conn == nil {
		return nil, nil, fmt.Errorf("can't reach the sandbox's egress proxy: %v", dialErr)
	}
	_ = conn.SetDeadline(time.Now().Add(answerTimeout))
	var b strings.Builder
	fmt.Fprintf(&b, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n", target, target)
	if via.auth != "" {
		fmt.Fprintf(&b, "Proxy-Authorization: %s\r\n", via.auth)
	}
	b.WriteString("\r\n")
	if _, err := io.WriteString(conn, b.String()); err != nil {
		conn.Close()
		return nil, nil, fmt.Errorf("the egress proxy closed the connection: %v", err)
	}
	reader := bufio.NewReader(conn)
	res, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil {
		conn.Close()
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			// The forwarder closes at once when the sandbox has no proxy (egress "none"), or can't reach it.
			return nil, nil, errors.New("the egress proxy closed the connection without answering (does this sandbox have a network?)")
		}
		return nil, nil, fmt.Errorf("no answer from the egress proxy: %v", err)
	}
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		conn.Close()
		reason := strings.TrimSpace(string(body))
		if reason == "" {
			reason = "the egress proxy answered " + res.Status
		}
		return nil, nil, errors.New(reason)
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, reader, nil
}
