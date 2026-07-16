// Pure URL → relay-endpoint resolution. Kept dependency-free + side-effect-free
// so it's unit-testable without touching the network.

export type Endpoints = { session: string; inbox: string; events: string; poll: string };

export type EndpointOptions = {
  /** Explicit token; falls back to ?token=/?key= in the URL. */
  token?: string;
  /** Relay mount path. Default "agent-relay" (the agent-integrations broker). */
  relayPath?: string;
};

/**
 * Resolve the relay POST (inbox) + SSE (events) endpoints from whatever
 * connection URL the user was handed. Two URL shapes are accepted:
 *
 *   1. Share URL:   https://host/anything?session=<id>&token=<tok>
 *   2. Direct path: https://host/<relayPath>/<id>[/inbox|/events|/outbox]?token=<tok>
 *
 * The agent (outbound) side reads the host's frames from `events?direction=outbound`
 * and POSTs its own frames to `inbox`.
 */
export function endpoints(rawUrl: string, opts: EndpointOptions = {}): Endpoints {
  const u = new URL(rawUrl);
  const relayPath = (opts.relayPath ?? "agent-relay").replace(/^\/|\/$/g, "");
  const token = opts.token || u.searchParams.get("token") || u.searchParams.get("key") || "";

  let session = "";
  let base = "";

  const qSession = u.searchParams.get("session");
  if (qSession) {
    session = qSession;
    base = `${u.origin}/${relayPath}`;
  } else {
    let segs = u.pathname.split("/").filter(Boolean);
    if (segs.length && ["inbox", "events", "outbox"].includes(segs[segs.length - 1]!)) {
      segs = segs.slice(0, -1);
    }
    session = segs[segs.length - 1] ?? "";
    base = u.origin + segs.slice(0, -1).map((s) => "/" + s).join("");
  }

  if (!token) throw new Error("no token in URL and --token / MCP_TOKEN unset");
  if (!session) throw new Error("could not determine session id from URL");

  const q = `token=${encodeURIComponent(token)}`;
  return {
    session,
    inbox: `${base}/${session}/inbox?${q}`,
    events: `${base}/${session}/events?${q}&direction=outbound`,
    poll: `${base}/${session}/poll?${q}&direction=outbound`,
  };
}
