#!/usr/bin/env bash
#
# connect.sh — super-lite MCP client for an agent-integrations relay session.
#
# Connects to a session-based MCP relay (the protocol shipped by
# @particle-academy/agent-integrations): you POST JSON-RPC to /inbox and read
# the host's responses from a server-sent-events /events stream. Drives any app
# that mounts the relay + a MicroMcpServer (e.g. the Fancy UI Agent Playground).
#
# Deps: bash + curl only. (jq / node / python used for pretty output if present.)
#
# Usage:
#   ./connect.sh <url> tools                 # list the tools the host exposes
#   ./connect.sh <url> call <name> ['<json>'] # call a tool (args default {})
#   ./connect.sh <url> send '<jsonrpc>'      # send a raw JSON-RPC frame
#   ./connect.sh <url> watch                 # stream every frame from the host
#
# <url> is whatever connection URL you were handed. The token (the "inline key")
# may be in the URL (?token=… or ?key=…) or supplied via MCP_TOKEN. Forms:
#   https://host/agent-playground?session=ABC&token=XYZ
#   https://host/whiteboard-share/ABC?token=XYZ
#   https://host/whiteboard-share/ABC/inbox?token=XYZ
#
# Env: MCP_TOKEN (token), MCP_RELAY_PATH (relay mount, default whiteboard-share).
set -euo pipefail

URL="${1:-}"; CMD="${2:-}"
[ -z "$URL" ] || [ -z "$CMD" ] && {
  grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '3,28p'; exit 2;
}
shift 2

RELAY_PATH="${MCP_RELAY_PATH:-whiteboard-share}"
ORIGIN=$(printf '%s' "$URL" | sed -E 's#^(https?://[^/]+).*#\1#')
PATHQ=$(printf '%s' "$URL" | sed -E 's#^https?://[^/]+##')

# token: MCP_TOKEN, then ?token=, then ?key=
TOKEN="${MCP_TOKEN:-}"
[ -z "$TOKEN" ] && [[ "$URL" =~ [?\&]token=([^\&]+) ]] && TOKEN="${BASH_REMATCH[1]}"
[ -z "$TOKEN" ] && [[ "$URL" =~ [?\&]key=([^\&]+) ]] && TOKEN="${BASH_REMATCH[1]}"
[ -z "$TOKEN" ] && { echo "error: no token in URL and MCP_TOKEN unset" >&2; exit 2; }

# session + base relay URL
if [[ "$URL" =~ [?\&]session=([^\&]+) ]]; then
  SESSION="${BASH_REMATCH[1]}"
  BASE="$ORIGIN/$RELAY_PATH"
else
  P="${PATHQ%%\?*}"; P="${P#/}"; P="${P%/}"
  case "$P" in */inbox|*/events|*/outbox) P="${P%/*}";; esac
  SESSION="${P##*/}"
  BASEP="${P%/*}"
  BASE="$ORIGIN/$BASEP"
fi
[ -z "$SESSION" ] && { echo "error: could not determine session from URL" >&2; exit 2; }

INBOX="$BASE/$SESSION/inbox?token=$TOKEN"
EVENTS="$BASE/$SESSION/events?token=$TOKEN&direction=outbound"

pretty() { # pretty-print JSON from stdin, falling back to raw
  if command -v jq >/dev/null 2>&1; then jq . 2>/dev/null || cat
  elif command -v node >/dev/null 2>&1; then node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s),null,2))}catch{process.stdout.write(s)}})'
  else cat; fi
}

# MCP_INSECURE=1 skips TLS verification (self-signed certs / local dev only).
CURL_OPTS=(); [ -n "${MCP_INSECURE:-}" ] && CURL_OPTS+=(-k)

SSE_FILE=$(mktemp)
# `${SSE_PID:-}` because an early exit (a usage error, a bad URL) fires this trap
# before the stream is started, and under `set -u` a bare $SSE_PID turns a clean
# "usage:" message into an unbound-variable error on the way out.
cleanup() { [ -n "${SSE_PID:-}" ] && kill "$SSE_PID" 2>/dev/null; rm -f "${SSE_FILE:-}"; return 0; }
trap cleanup EXIT
curl "${CURL_OPTS[@]}" -sN "$EVENTS" > "$SSE_FILE" 2>/dev/null & SSE_PID=$!

# The relay accepts a POST and answers on the SSE stream, so a 2xx here means
# "queued", NOT "handled". A 4xx (bad token, dead session) used to be discarded
# into /dev/null and surfaced later as an unexplained timeout.
post() {
  local code
  code=$(curl "${CURL_OPTS[@]}" -s -o /dev/null -w '%{http_code}' \
    -X POST "$INBOX" -H 'content-type: application/json' -d "$1")
  case "$code" in
    2*) return 0 ;;
    401|403) echo "error: relay rejected the token (HTTP $code) — the session link may have expired." >&2; return 1 ;;
    404) echo "error: no such session (HTTP 404) — check the session id in the link." >&2; return 1 ;;
    *)   echo "error: relay refused the frame (HTTP $code)." >&2; return 1 ;;
  esac
}

# WAIT_TICKS x 0.2s. Overridable: some tools (a big page_describe, a slow nav)
# legitimately take longer than the old fixed 15s.
WAIT_TICKS="${MCP_WAIT_TICKS:-75}"

await() { # $1=id ; echo the matching frame's JSON (data: stripped), or fail LOUDLY
  local id="$1" i=0 line
  while [ "$i" -lt "$WAIT_TICKS" ]; do
    line=$(grep -a "\"id\":$id[,}]" "$SSE_FILE" 2>/dev/null | head -1 || true)
    [ -n "$line" ] && { printf '%s\n' "${line#data: }"; return 0; }
    sleep 0.2; i=$((i+1))
  done
  diagnose "$id"
  return 1
}

# Why did the wait fail? Silence is the worst answer — an agent cannot tell
# "session dead" from "nobody is on the page" from "client bug", and every one of
# those needs a different response from whoever is driving.
diagnose() {
  local id="$1" frames
  frames=$(grep -ca '^data: ' "$SSE_FILE" 2>/dev/null || echo 0)
  echo "error: no reply to request id=$id after $(( WAIT_TICKS / 5 ))s." >&2
  if [ "$frames" -eq 0 ]; then
    echo "  The event stream delivered NOTHING. The relay is not sending —" >&2
    echo "  check the session id/token in the link, or the session has ended." >&2
  else
    echo "  The stream IS live ($frames frame(s) received), so the relay is fine." >&2
    echo "  The request reached it and nothing answered, which almost always means" >&2
    echo "  NO BROWSER IS ATTACHED to this session — the human needs the app open" >&2
    echo "  on the shared page. Tool calls are answered by that page, not by the relay," >&2
    echo "  which is why 'tools' can succeed while every 'call' times out." >&2
  fi
  echo "  Raise the wait with MCP_WAIT_TICKS=300 (60s) if the tool is just slow." >&2
}

if [ "$CMD" = "watch" ]; then
  echo "# watching $BASE/$SESSION (Ctrl-C to stop)" >&2
  tail -n +1 -f "$SSE_FILE" | sed -u -n 's/^data: //p'
  exit 0
fi

# Validate usage BEFORE touching the network. A malformed command is the
# caller's mistake and must not need a live session to report — otherwise a typo
# in the arguments comes back as "the relay rejected the token", which sends
# whoever is debugging in entirely the wrong direction.
if [ "$CMD" = "call" ]; then
  [ -z "${1:-}" ] && { echo "usage: connect.sh <url> call <name> ['<json-args>']" >&2; exit 2; }
  CALL_ARGS="${2:-}"
  [ -z "$CALL_ARGS" ] && CALL_ARGS='{}'
  # jq OR node — gating this on jq alone silently skipped validation on every
  # machine without it, which is most of them. `pretty()` already assumes one of
  # the two, so this adds no new requirement.
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$CALL_ARGS" | jq -e . >/dev/null 2>&1 || BAD_ARGS=1
  elif command -v node >/dev/null 2>&1; then
    printf '%s' "$CALL_ARGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s)}catch{process.exit(1)}})' 2>/dev/null || BAD_ARGS=1
  fi
  if [ -n "${BAD_ARGS:-}" ]; then
    echo "error: arguments are not valid JSON: $CALL_ARGS" >&2
    echo "  Quote them for the shell, e.g.  call page_click '{\"handle\":\"link#2\"}'" >&2
    exit 2
  fi
fi

sleep 1  # let the SSE subscription register (also pings the host: peer_joined)
post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"connect.sh","version":"1"}}}'
await 1 >/dev/null || { echo "error: no response — is the session live and the host connected?" >&2; exit 1; }
post '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# `await N | pretty` is WRONG and was the reason every failure was silent: in a
# pipeline the exit status is `pretty`'s, so an await that returned 1 printed
# nothing and still looked like success. Capture first, then pretty-print.
emit() { # $1=id — await it, print it, or exit non-zero having explained why
  local out
  out=$(await "$1") || exit 1
  printf '%s\n' "$out" | pretty
}

case "$CMD" in
  tools)
    post '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' || exit 1
    emit 2 ;;
  call)
    # NAME/CALL_ARGS were validated above, before any network call.
    # NOTE: `${2:-{}}` is the trap here — bash ends the expansion at the first
    # `}`, so the trailing brace is appended literally and every call WITH
    # arguments posted `"arguments":{}}}}`, invalid JSON the host silently
    # dropped. CALL_ARGS is built with a plain test instead.
    post "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$CALL_ARGS}}" || exit 1
    emit 3 ;;
  send)
    FRAME="${1:-}"
    [ -z "$FRAME" ] && { echo "usage: connect.sh <url> send '<jsonrpc-frame>'" >&2; exit 2; }
    post "$FRAME" || exit 1
    ID=$(printf '%s' "$FRAME" | sed -nE 's/.*"id":([0-9]+).*/\1/p' | head -1)
    [ -n "$ID" ] && { emit "$ID"; } || { sleep 1; echo "(sent; no id to await)"; } ;;
  *)
    echo "unknown command: $CMD (use tools|call|send|watch)" >&2; exit 2 ;;
esac
