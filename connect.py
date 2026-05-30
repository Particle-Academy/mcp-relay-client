#!/usr/bin/env python3
"""connect.py — super-lite MCP client for an agent-integrations relay session.

Connects to a session-based MCP relay (the protocol shipped by
@particle-academy/agent-integrations): POST JSON-RPC to /inbox, read the host's
responses from a server-sent-events /events stream. Drives any app that mounts
the relay + a MicroMcpServer (e.g. the Fancy UI Agent Playground).

Deps: Python 3.8+ stdlib only.

Usage:
  python3 connect.py <url> tools                  # list the host's tools
  python3 connect.py <url> call <name> ['<json>']  # call a tool (args default {})
  python3 connect.py <url> send '<jsonrpc>'        # send a raw JSON-RPC frame
  python3 connect.py <url> watch                   # stream every frame from host

<url> is whatever connection URL you were handed; the token (the "inline key")
may be in it (?token=… or ?key=…) or supplied via MCP_TOKEN. Forms:
  https://host/agent-playground?session=ABC&token=XYZ
  https://host/whiteboard-share/ABC?token=XYZ
  https://host/whiteboard-share/ABC/inbox?token=XYZ

Env: MCP_TOKEN, MCP_RELAY_PATH (default whiteboard-share), MCP_INSECURE (skip TLS).
"""
import json
import os
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request

RELAY_PATH = os.environ.get("MCP_RELAY_PATH", "whiteboard-share")
INSECURE = bool(os.environ.get("MCP_INSECURE"))
SSL_CTX = ssl._create_unverified_context() if INSECURE else None


def die(msg):
    sys.stderr.write("error: " + msg + "\n")
    sys.exit(1)


def endpoints(url):
    """Parse a connection URL into (inbox, events) relay endpoints."""
    u = urllib.parse.urlparse(url)
    q = urllib.parse.parse_qs(u.query)
    token = os.environ.get("MCP_TOKEN") or (q.get("token") or q.get("key") or [""])[0]
    origin = "%s://%s" % (u.scheme, u.netloc)
    if "session" in q:
        session = q["session"][0]
        base = "%s/%s" % (origin, RELAY_PATH.strip("/"))
    else:
        segs = [s for s in u.path.split("/") if s]
        if segs and segs[-1] in ("inbox", "events", "outbox"):
            segs = segs[:-1]
        session = segs[-1] if segs else ""
        base = origin + "".join("/" + s for s in segs[:-1])
    if not token:
        die("no token in URL and MCP_TOKEN unset")
    if not session:
        die("could not determine session from URL")
    inbox = "%s/%s/inbox?token=%s" % (base, session, token)
    events = "%s/%s/events?token=%s&direction=outbound" % (base, session, token)
    return inbox, events


class Relay:
    def __init__(self, inbox, events):
        self.inbox = inbox
        self.events = events
        self.lock = threading.Lock()
        self.responses = {}
        self.watch = False

    def _read_sse(self):
        req = urllib.request.Request(self.events, headers={"accept": "text/event-stream"})
        with urllib.request.urlopen(req, context=SSL_CTX) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "ignore").rstrip("\r\n")
                if not line.startswith("data: "):
                    continue
                try:
                    frame = json.loads(line[6:])
                except ValueError:
                    continue
                if self.watch:
                    print(json.dumps(frame))
                    sys.stdout.flush()
                elif "id" in frame:
                    with self.lock:
                        self.responses[frame["id"]] = frame

    def start(self):
        threading.Thread(target=self._read_sse, daemon=True).start()
        time.sleep(1.0)  # let the subscription register (pings host: peer_joined)

    def post(self, frame):
        data = json.dumps(frame).encode("utf-8")
        req = urllib.request.Request(
            self.inbox, data=data, method="POST",
            headers={"content-type": "application/json"},
        )
        urllib.request.urlopen(req, context=SSL_CTX).read()

    def await_id(self, frame_id, timeout=15.0):
        end = time.time() + timeout
        while time.time() < end:
            with self.lock:
                if frame_id in self.responses:
                    return self.responses[frame_id]
            time.sleep(0.1)
        return None


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        sys.stderr.write(__doc__)
        sys.exit(2)
    url, cmd, rest = args[0], args[1], args[2:]
    inbox, events = endpoints(url)
    relay = Relay(inbox, events)

    if cmd == "watch":
        relay.watch = True
        sys.stderr.write("# watching (Ctrl-C to stop)\n")
        relay._read_sse()
        return

    relay.start()
    relay.post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "connect.py", "version": "1"}}})
    if relay.await_id(1) is None:
        die("no response — is the session live and the host connected?")
    relay.post({"jsonrpc": "2.0", "method": "notifications/initialized"})

    if cmd == "tools":
        relay.post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        result = relay.await_id(2)
    elif cmd == "call":
        if not rest:
            die("usage: connect.py <url> call <name> ['<json-args>']")
        name = rest[0]
        arguments = json.loads(rest[1]) if len(rest) > 1 else {}
        relay.post({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                    "params": {"name": name, "arguments": arguments}})
        result = relay.await_id(3)
    elif cmd == "send":
        if not rest:
            die("usage: connect.py <url> send '<jsonrpc-frame>'")
        frame = json.loads(rest[0])
        relay.post(frame)
        result = relay.await_id(frame["id"]) if "id" in frame else None
    else:
        die("unknown command: %s (use tools|call|send|watch)" % cmd)

    print(json.dumps(result, indent=2) if result is not None else "(no response)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
