import { describe, it, expect } from "vitest";
import { endpoints } from "../src/endpoints.js";

describe("endpoints", () => {
  it("resolves a share URL (?session=&token=) against the default relay path", () => {
    const ep = endpoints("https://ui.particle.academy/agent-playground?session=ABC&token=XYZ");
    expect(ep.session).toBe("ABC");
    expect(ep.inbox).toBe("https://ui.particle.academy/whiteboard-share/ABC/inbox?token=XYZ");
    expect(ep.events).toBe(
      "https://ui.particle.academy/whiteboard-share/ABC/events?token=XYZ&direction=outbound",
    );
  });

  it("accepts ?key= as the token alias", () => {
    const ep = endpoints("https://x.test/?session=S1&key=K1");
    expect(ep.inbox).toContain("/S1/inbox?token=K1");
  });

  it("resolves a direct relay path URL and strips a trailing inbox/events/outbox segment", () => {
    const ep = endpoints("https://x.test/whiteboard-share/S2/events?token=T2");
    expect(ep.session).toBe("S2");
    expect(ep.inbox).toBe("https://x.test/whiteboard-share/S2/inbox?token=T2");
  });

  it("honors an explicit token over the URL", () => {
    const ep = endpoints("https://x.test/?session=S3&token=URLTOK", { token: "OPTTOK" });
    expect(ep.inbox).toContain("token=OPTTOK");
  });

  it("honors a custom relay path", () => {
    const ep = endpoints("https://x.test/?session=S4&token=T4", { relayPath: "agent-share" });
    expect(ep.inbox).toBe("https://x.test/agent-share/S4/inbox?token=T4");
  });

  it("url-encodes the token", () => {
    const ep = endpoints("https://x.test/?session=S5&token=a%2Fb"); // a/b
    expect(ep.inbox).toContain("token=a%2Fb");
  });

  it("throws when the token is missing", () => {
    expect(() => endpoints("https://x.test/?session=S6")).toThrow(/token/i);
  });

  it("throws when the session cannot be determined", () => {
    expect(() => endpoints("https://x.test/?token=T7")).toThrow(/session/i);
  });
});
