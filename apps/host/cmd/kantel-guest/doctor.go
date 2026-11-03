package main

import (
	"bytes"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The host proxy's side of the check (internal/egress): kept here as text so the guest binary doesn't carry the proxy.
const (
	checkHeader      = "X-Kantel-Proxy-Check"
	errorHeader      = "X-Kantel-Proxy-Error"
	variableHeader   = "X-Kantel-Proxy-Variable"
	placeholdersURL  = "http://kantel.check/placeholders"
	caFile           = "/usr/local/share/ca-certificates/kantel-egress.crt"
	trustStore       = "/etc/ssl/certs/ca-certificates.crt"
	placeholderBody  = 40
	placeholderStart = "kph_"
)

// placeholders is the proxy's answer at placeholdersURL: names, a prefix of each placeholder and bound hosts, never
// a value.
type placeholders struct {
	Variables []struct {
		Name   string   `json:"name"`
		Prefix string   `json:"prefix"`
		Hosts  []string `json:"hosts"`
	} `json:"variables"`
}

// doctor checks, from inside the sandbox, that protected variables will work: the proxy is set, the sandbox trusts
// its egress certificate, and each placeholder in the environment would be swapped at each host it is bound to. The
// checks go through the proxy with the placeholder only; the proxy answers them itself and sends nothing on.
func doctor(out io.Writer) int {
	failed := false
	report := func(ok bool, check, detail string) {
		word := "ok"
		if !ok {
			word, failed = "fail", true
		}
		fmt.Fprintf(out, "%s %s: %s\n", word, check, detail)
	}
	env := doctorEnv()

	httpProxy, httpsProxy := firstOf(env, "HTTP_PROXY", "http_proxy"), firstOf(env, "HTTPS_PROXY", "https_proxy")
	report(httpProxy != "", "HTTP_PROXY", setOrNot(httpProxy))
	report(httpsProxy != "", "HTTPS_PROXY", setOrNot(httpsProxy))

	var names []string
	for k, v := range env {
		if isPlaceholder(v) {
			names = append(names, k)
		}
	}
	sort.Strings(names)

	checkCA(report, len(names) > 0)

	if len(names) == 0 {
		report(true, "protected variables", "none in this environment")
		return exit(failed)
	}
	if httpProxy == "" || httpsProxy == "" {
		report(false, "protected variables", "can't be checked without the proxy")
		return exit(true)
	}
	known, err := fetchPlaceholders(httpProxy)
	if err != nil {
		report(false, "protected variables", err.Error())
		return exit(true)
	}
	for _, name := range names {
		ph := env[name]
		var hosts []string
		found := false
		for _, v := range known.Variables {
			if v.Name == name && v.Prefix != "" && strings.HasPrefix(ph, v.Prefix) {
				hosts, found = v.Hosts, true
				break
			}
		}
		if !found {
			report(false, name, "the proxy doesn't know this placeholder (from another sandbox, or the variable was removed), so it is never swapped")
			continue
		}
		if len(hosts) == 0 {
			report(false, name, "bound to no host, so it is never swapped")
			continue
		}
		for _, host := range hosts {
			check := name + " " + host
			if strings.Contains(host, "*") {
				report(true, check, "not checked: a wildcard binding has no one host to try")
				continue
			}
			ok, detail := checkPlaceholder(httpsProxy, host, ph)
			report(ok, check, detail)
		}
	}
	return exit(failed)
}

func exit(failed bool) int {
	if failed {
		return 1
	}
	return 0
}

func setOrNot(v string) string {
	if v == "" {
		return "not set, so nothing leaves through the host's proxy"
	}
	// The user name may be a label and the proxy's URL holds no secret, but there's no need to print either.
	if u, err := url.Parse(v); err == nil && u.Host != "" {
		return "set (" + u.Host + ")"
	}
	return "set"
}

// doctorEnv is the environment as a command run by the agent gets it: the process's own, then what the agent wrote
// for the sandbox (proxy.env, env) for anything the process wasn't given, as when run from a shell that predates it.
func doctorEnv() map[string]string {
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			env[k] = v
		}
	}
	for _, file := range []string{"/etc/kantel/proxy.env", "/etc/kantel/env"} {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(raw), "\n") {
			k, v, ok := strings.Cut(line, "=")
			if !ok || k == "" {
				continue
			}
			if unq, err := strconv.Unquote(v); err == nil {
				v = unq
			}
			if _, set := env[k]; !set {
				env[k] = v
			}
		}
	}
	return env
}

func firstOf(env map[string]string, keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(env[k]); v != "" {
			return v
		}
	}
	return ""
}

func isPlaceholder(s string) bool {
	body, ok := strings.CutPrefix(s, placeholderStart)
	if !ok || len(body) != placeholderBody {
		return false
	}
	for _, c := range body {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
			return false
		}
	}
	return true
}

// checkCA checks every certificate in the egress CA file is in the system's trust store, which is what programs
// verify the proxy's certificates with. With no placeholders there may be nothing intercepted, so no file is fine.
func checkCA(report func(bool, string, string), needed bool) {
	raw, err := os.ReadFile(caFile)
	if errors.Is(err, os.ErrNotExist) {
		if needed {
			report(false, "egress certificate", caFile+" is missing, so the proxy's certificates won't be trusted")
		} else {
			report(true, "egress certificate", "none installed (nothing to intercept)")
		}
		return
	}
	if err != nil {
		report(false, "egress certificate", err.Error())
		return
	}
	certs := parseCerts(raw)
	if len(certs) == 0 {
		report(false, "egress certificate", caFile+" holds no certificate")
		return
	}
	bundle, err := os.ReadFile(trustStore)
	if err != nil {
		report(false, "egress certificate", "can't read "+trustStore+": "+err.Error())
		return
	}
	trusted := parseCerts(bundle)
	for _, c := range certs {
		in := false
		for _, t := range trusted {
			if bytes.Equal(c.Raw, t.Raw) {
				in = true
				break
			}
		}
		if !in {
			report(false, "egress certificate", fmt.Sprintf("%q isn't in %s: run update-ca-certificates as root", c.Subject.CommonName, trustStore))
			return
		}
	}
	report(true, "egress certificate", "in "+trustStore)
}

func parseCerts(raw []byte) []*x509.Certificate {
	var out []*x509.Certificate
	for {
		var block *pem.Block
		block, raw = pem.Decode(raw)
		if block == nil {
			return out
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		if c, err := x509.ParseCertificate(block.Bytes); err == nil {
			out = append(out, c)
		}
	}
}

func proxyClient(proxy string) (*http.Client, error) {
	u, err := url.Parse(proxy)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("the proxy URL %q isn't a URL", proxy)
	}
	return &http.Client{
		Transport: &http.Transport{Proxy: http.ProxyURL(u), TLSHandshakeTimeout: 15 * time.Second, DisableKeepAlives: true},
		Timeout:   30 * time.Second,
		// A check is answered by the proxy itself; following anything else would test something other than it.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}, nil
}

func fetchPlaceholders(proxy string) (placeholders, error) {
	var out placeholders
	client, err := proxyClient(proxy)
	if err != nil {
		return out, err
	}
	res, err := client.Get(placeholdersURL)
	if err != nil {
		return out, fmt.Errorf("can't ask the proxy for this sandbox's placeholders: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return out, fmt.Errorf("the proxy answered %d for this sandbox's placeholders%s", res.StatusCode, codeOf(res))
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil {
		return out, fmt.Errorf("the proxy's list of placeholders isn't JSON: %v", err)
	}
	return out, nil
}

// checkPlaceholder sends HEAD https://host/ through the proxy carrying the placeholder in the check header: the proxy
// answers after a verified TLS handshake with host, and sends nothing on.
func checkPlaceholder(proxy, host, placeholder string) (bool, string) {
	client, err := proxyClient(proxy)
	if err != nil {
		return false, err.Error()
	}
	req, err := http.NewRequest(http.MethodHead, "https://"+host+"/", nil)
	if err != nil {
		return false, err.Error()
	}
	req.Header.Set(checkHeader, placeholder)
	res, err := client.Do(req)
	if err != nil {
		var unknown x509.UnknownAuthorityError
		if errors.As(err, &unknown) {
			return false, "this sandbox doesn't trust the proxy's certificate for " + host + " (see the egress certificate check)"
		}
		return false, "the check couldn't be made: " + err.Error()
	}
	res.Body.Close()
	if res.StatusCode == http.StatusNoContent && res.Header.Get(checkHeader) == "ok" {
		return true, "would be swapped"
	}
	if res.Header.Get(checkHeader) == "" && res.Header.Get(errorHeader) == "" {
		return false, fmt.Sprintf("answered %d by something other than the proxy's check: is %s intercepted?", res.StatusCode, host)
	}
	return false, fmt.Sprintf("answered %d%s", res.StatusCode, codeOf(res))
}

func codeOf(res *http.Response) string {
	code := res.Header.Get(errorHeader)
	if code == "" {
		code = res.Header.Get(checkHeader)
	}
	if code == "" {
		return ""
	}
	if v := res.Header.Get(variableHeader); v != "" {
		return " (" + code + ", " + v + ")"
	}
	return " (" + code + ")"
}
