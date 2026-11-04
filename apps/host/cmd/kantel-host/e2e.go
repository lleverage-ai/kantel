package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/agent"
	"github.com/lleverage-ai/kantel/apps/host/internal/e2e"
)

// The host's E2E chain endpoints on the control plane, with the host's credential: the space's chain as the gateway
// holds it (to verify, never to trust), and the host.add the host signs, for devices to fetch.
const hostChainPath = "/v1/hosts/e2e/chain"

func e2eCmd(args []string) error {
	if len(args) == 0 {
		return errors.New(`e2e: want "key", "join <ticket>" or "status"`)
	}
	fs := flag.NewFlagSet("e2e "+args[0], flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath, "config file")
	chainFile := fs.String("chain", "", "join: read the space's chain from this file (JSON entries) instead of from Kantel, and print the host.add instead of publishing it")
	_ = fs.Parse(args[1:])
	cfg, err := agent.LoadConfig(*configPath)
	if err != nil {
		return err
	}
	store, err := e2e.OpenStore(filepath.Join(cfg.Root, "e2e"))
	if err != nil {
		return err
	}
	switch args[0] {
	case "key":
		id, err := store.Identity()
		if err != nil {
			return err
		}
		fmt.Printf("host %s\nsign %s\ndh %s\nfingerprint %s\n", cfg.HostID, e2e.B64(id.SignPublic()), e2e.B64(id.DHPublic()), e2e.Fingerprint(id.SignPublic(), id.DHPublic()))
		return nil
	case "status":
		spaces := store.Spaces()
		if len(spaces) == 0 {
			fmt.Println("no E2E spaces: run `kantel-host e2e join <ticket>` with a ticket from `kantel e2e hosts ticket`")
			return nil
		}
		for _, space := range spaces {
			st := store.Space(space).State()
			if st == nil {
				fmt.Printf("%s: the chain doesn't verify (every session and plaintext call refused)\n", space)
				continue
			}
			fmt.Printf("%s: mode %s, seq %d, %d members, %d devices, %d hosts\n", space, st.Mode, st.Seq, len(st.Members), len(st.Devices), len(st.Hosts))
		}
		return nil
	case "join":
		if fs.NArg() != 1 {
			return errors.New("e2e join <ticket>")
		}
		if cfg.HostID == "" {
			return errors.New("join Kantel first (`kantel-host install`): the chain names the host by its ID")
		}
		join, err := e2e.DecodeJoinTicket(strings.TrimSpace(fs.Arg(0)))
		if err != nil {
			return err
		}
		space, _, name := join.TicketSpace()
		var entries []e2e.Entry
		if *chainFile != "" {
			raw, err := os.ReadFile(*chainFile)
			if err != nil {
				return err
			}
			if err := json.Unmarshal(raw, &entries); err != nil {
				var wrapped struct {
					Entries []e2e.Entry `json:"entries"`
				}
				if err := json.Unmarshal(raw, &wrapped); err != nil {
					return fmt.Errorf("%s: %w", *chainFile, err)
				}
				entries = wrapped.Entries
			}
		} else if entries, err = fetchChain(cfg, space); err != nil {
			return err
		}
		entry, st, err := store.Join(join, entries, cfg.HostID, time.Now())
		if err != nil {
			return err
		}
		id, _ := store.Identity()
		fmt.Fprintf(os.Stderr, "joined %s as %q (%s): mode %s; fingerprint %s\n", space, name, cfg.HostID, st.Mode, e2e.Fingerprint(id.SignPublic(), id.DHPublic()))
		if entry.Payload == "" {
			return nil
		}
		if *chainFile != "" {
			out, _ := json.Marshal(entry)
			fmt.Println(string(out))
			return nil
		}
		return publish(cfg, space, len(entries), entry)
	}
	return fmt.Errorf("e2e: unknown command %q", args[0])
}

func controlPlane(cfg agent.Config, method, path string, body io.Reader) (*http.Response, error) {
	if cfg.ControlPlane == "" || cfg.Credential == "" {
		return nil, errors.New("this host isn't joined to Kantel: give --chain to join a space from a file")
	}
	req, err := http.NewRequest(method, strings.TrimRight(cfg.ControlPlane, "/")+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Credential)
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		res.Body.Close()
		return nil, fmt.Errorf("%s %s: %d %s", method, path, res.StatusCode, bytes.TrimSpace(msg))
	}
	return res, nil
}

func fetchChain(cfg agent.Config, space string) ([]e2e.Entry, error) {
	res, err := controlPlane(cfg, http.MethodGet, hostChainPath+"?space="+url.QueryEscape(space), nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var out struct {
		Entries []e2e.Entry `json:"entries"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<20)).Decode(&out); err != nil {
		return nil, err
	}
	return out.Entries, nil
}

func publish(cfg agent.Config, space string, from int, entry e2e.Entry) error {
	body, _ := json.Marshal(map[string]any{"space": space, "from": from, "entries": []e2e.Entry{entry}})
	res, err := controlPlane(cfg, http.MethodPost, hostChainPath, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("the host joined, but publishing its entry failed (run join again): %w", err)
	}
	res.Body.Close()
	return nil
}
