// connect.go — super-lite MCP client for an agent-integrations relay session.
//
// Connects to a session-based MCP relay (the protocol shipped by
// @particle-academy/agent-integrations): POST JSON-RPC to /inbox, read the
// host's responses from a server-sent-events /events stream. Drives any app
// that mounts the relay + a MicroMcpServer (e.g. the Fancy UI Agent Playground).
//
// Stdlib only. Run with `go run connect.go ...` or `go build -o connect connect.go`.
//
// Usage:
//   connect <url> tools                  # list the host's tools
//   connect <url> call <name> ['<json>']  # call a tool (args default {})
//   connect <url> send '<jsonrpc>'        # send a raw JSON-RPC frame
//   connect <url> watch                   # stream every frame from the host
//
// <url> is whatever connection URL you were handed; the token (the "inline
// key") may be in it (?token=… / ?key=…) or supplied via MCP_TOKEN.
//
// Env: MCP_TOKEN, MCP_RELAY_PATH (default whiteboard-share), MCP_INSECURE (skip TLS).
package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

func die(msg string) {
	fmt.Fprintln(os.Stderr, "error: "+msg)
	os.Exit(1)
}

func relayPath() string {
	if p := os.Getenv("MCP_RELAY_PATH"); p != "" {
		return p
	}
	return "whiteboard-share"
}

func endpoints(raw string) (inbox, events string) {
	u, err := url.Parse(raw)
	if err != nil {
		die("bad url: " + err.Error())
	}
	q := u.Query()
	token := os.Getenv("MCP_TOKEN")
	if token == "" {
		token = q.Get("token")
	}
	if token == "" {
		token = q.Get("key")
	}
	origin := u.Scheme + "://" + u.Host
	var session, base string
	if s := q.Get("session"); s != "" {
		session = s
		base = origin + "/" + strings.Trim(relayPath(), "/")
	} else {
		var segs []string
		for _, s := range strings.Split(u.Path, "/") {
			if s != "" {
				segs = append(segs, s)
			}
		}
		if n := len(segs); n > 0 && (segs[n-1] == "inbox" || segs[n-1] == "events" || segs[n-1] == "outbox") {
			segs = segs[:n-1]
		}
		if len(segs) > 0 {
			session = segs[len(segs)-1]
			base = origin
			for _, s := range segs[:len(segs)-1] {
				base += "/" + s
			}
		}
	}
	if token == "" {
		die("no token in URL and MCP_TOKEN unset")
	}
	if session == "" {
		die("could not determine session from URL")
	}
	inbox = fmt.Sprintf("%s/%s/inbox?token=%s", base, session, token)
	events = fmt.Sprintf("%s/%s/events?token=%s&direction=outbound", base, session, token)
	return
}

type frame map[string]any

type relay struct {
	inbox, events string
	client        *http.Client
	mu            sync.Mutex
	responses     map[any]frame
	watch         bool
}

func newRelay(inbox, events string) *relay {
	tr := &http.Transport{}
	if os.Getenv("MCP_INSECURE") != "" {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return &relay{inbox: inbox, events: events, client: &http.Client{Transport: tr}, responses: map[any]frame{}}
}

func (r *relay) readSSE() {
	resp, err := r.client.Get(r.events)
	if err != nil {
		die("sse connect: " + err.Error())
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 1024*1024), 8*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var f frame
		if json.Unmarshal([]byte(line[6:]), &f) != nil {
			continue
		}
		if r.watch {
			b, _ := json.Marshal(f)
			fmt.Println(string(b))
			continue
		}
		if id, ok := f["id"]; ok {
			r.mu.Lock()
			r.responses[normID(id)] = f
			r.mu.Unlock()
		}
	}
}

// JSON numbers decode as float64; normalize ids so int/float keys match.
func normID(id any) any {
	if fv, ok := id.(float64); ok {
		return fmt.Sprintf("%v", fv)
	}
	return fmt.Sprintf("%v", id)
}

func (r *relay) post(f frame) {
	b, _ := json.Marshal(f)
	resp, err := r.client.Post(r.inbox, "application/json", bytes.NewReader(b))
	if err != nil {
		die("post: " + err.Error())
	}
	resp.Body.Close()
}

func (r *relay) await(id any, timeout time.Duration) frame {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		f, ok := r.responses[normID(id)]
		r.mu.Unlock()
		if ok {
			return f
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil
}

func main() {
	args := os.Args[1:]
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: connect <url> {tools|call <name> [json]|send <frame>|watch}")
		os.Exit(2)
	}
	url, cmd, rest := args[0], args[1], args[2:]
	inbox, events := endpoints(url)
	r := newRelay(inbox, events)

	if cmd == "watch" {
		r.watch = true
		fmt.Fprintln(os.Stderr, "# watching (Ctrl-C to stop)")
		r.readSSE()
		return
	}

	go r.readSSE()
	time.Sleep(1 * time.Second) // let SSE subscribe (pings host: peer_joined)

	r.post(frame{"jsonrpc": "2.0", "id": 1, "method": "initialize",
		"params": frame{"protocolVersion": "2025-06-18", "capabilities": frame{},
			"clientInfo": frame{"name": "connect.go", "version": "1"}}})
	if r.await(1, 15*time.Second) == nil {
		die("no response — is the session live and the host connected?")
	}
	r.post(frame{"jsonrpc": "2.0", "method": "notifications/initialized"})

	var result frame
	switch cmd {
	case "tools":
		r.post(frame{"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
		result = r.await(2, 15*time.Second)
	case "call":
		if len(rest) == 0 {
			die("usage: connect <url> call <name> ['<json-args>']")
		}
		var arguments any = map[string]any{}
		if len(rest) > 1 {
			if json.Unmarshal([]byte(rest[1]), &arguments) != nil {
				die("invalid JSON args")
			}
		}
		r.post(frame{"jsonrpc": "2.0", "id": 3, "method": "tools/call",
			"params": frame{"name": rest[0], "arguments": arguments}})
		result = r.await(3, 15*time.Second)
	case "send":
		if len(rest) == 0 {
			die("usage: connect <url> send '<jsonrpc-frame>'")
		}
		var f frame
		if json.Unmarshal([]byte(rest[0]), &f) != nil {
			die("invalid JSON frame")
		}
		r.post(f)
		if id, ok := f["id"]; ok {
			result = r.await(id, 15*time.Second)
		}
	default:
		die("unknown command: " + cmd + " (use tools|call|send|watch)")
	}

	if result == nil {
		fmt.Println("(no response)")
		return
	}
	out, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(out))
}
