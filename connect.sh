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
cleanup() { kill "$SSE_PID" 2>/dev/null || true; rm -f "$SSE_FILE"; }
trap cleanup EXIT
curl "${CURL_OPTS[@]}" -sN "$EVENTS" > "$SSE_FILE" 2>/dev/null & SSE_PID=$!

post() { curl "${CURL_OPTS[@]}" -s -X POST "$INBOX" -H 'content-type: application/json' -d "$1" >/dev/null; }
await() { # $1=id ; echo the matching frame's JSON (data: stripped), or fail
  local id="$1" i=0 line
  while [ $i -lt 75 ]; do
    line=$(grep -a "\"id\":$id[,}]" "$SSE_FILE" 2>/dev/null | head -1 || true)
    [ -n "$line" ] && { printf '%s\n' "${line#data: }"; return 0; }
    sleep 0.2; i=$((i+1))
  done
  return 1
}

if [ "$CMD" = "watch" ]; then
  echo "# watching $BASE/$SESSION (Ctrl-C to stop)" >&2
  tail -n +1 -f "$SSE_FILE" | sed -u -n 's/^data: //p'
  exit 0
fi

sleep 1  # let the SSE subscription register (also pings the host: peer_joined)
post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"connect.sh","version":"1"}}}'
await 1 >/dev/null || { echo "error: no response — is the session live and the host connected?" >&2; exit 1; }
post '{"jsonrpc":"2.0","method":"notifications/initialized"}'

case "$CMD" in
  tools)
    post '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
    await 2 | pretty ;;
  call)
    NAME="${1:-}"; ARGS="${2:-{}}"
    [ -z "$NAME" ] && { echo "usage: connect.sh <url> call <name> ['<json-args>']" >&2; exit 2; }
    post "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"$NAME\",\"arguments\":$ARGS}}"
    await 3 | pretty ;;
  send)
    FRAME="${1:-}"
    [ -z "$FRAME" ] && { echo "usage: connect.sh <url> send '<jsonrpc-frame>'" >&2; exit 2; }
    post "$FRAME"
    ID=$(printf '%s' "$FRAME" | sed -nE 's/.*"id":([0-9]+).*/\1/p' | head -1)
    [ -n "$ID" ] && { await "$ID" | pretty; } || { sleep 1; echo "(sent; no id to await)"; } ;;
  *)
    echo "unknown command: $CMD (use tools|call|send|watch)" >&2; exit 2 ;;
esac
