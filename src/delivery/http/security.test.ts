import { describe, expect, it } from "vitest";
import { validateRequestSecurity } from "./security.ts";

const allowed = new Set(["127.0.0.1", "localhost", "::1"]);

function post(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:8787/v1/session", {
    method: "POST",
    headers,
  });
}

describe("validateRequestSecurity host allowlist", () => {
  it("allows an allowlisted loopback Host", () => {
    expect(validateRequestSecurity(post({ host: "127.0.0.1:8787" }), allowed)).toEqual({
      ok: true,
    });
  });

  it("trusts private, .local, and Tailscale names without listing them", () => {
    for (const host of [
      "192.168.1.10:8787",
      "10.0.0.5",
      "172.16.9.9",
      "169.254.1.1",
      "thebe.local",
      "myhost.tailnet.ts.net",
      "[fd00::1]:8787",
    ]) {
      expect(validateRequestSecurity(post({ host }), allowed), host).toEqual({
        ok: true,
      });
    }
  });

  it("rejects a public host that is not listed", () => {
    expect(validateRequestSecurity(post({ host: "evil.com" }), allowed).ok).toBe(false);
  });

  it("accepts any Host when the allowlist is the wildcard", () => {
    const wildcard = new Set(["*"]);
    expect(validateRequestSecurity(post({ host: "evil.com" }), wildcard)).toEqual({
      ok: true,
    });
  });

  it("rejects a cross-site browser request", () => {
    const result = validateRequestSecurity(
      post({ host: "127.0.0.1:8787", "sec-fetch-site": "cross-site" }),
      allowed,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a cross-origin public Origin", () => {
    const result = validateRequestSecurity(
      post({ host: "127.0.0.1:8787", origin: "https://evil.com" }),
      allowed,
    );
    expect(result.ok).toBe(false);
  });

  it("leaves GET/HEAD alone", () => {
    const request = new Request("http://127.0.0.1:8787/v1/health", {
      method: "GET",
      headers: { host: "evil.com" },
    });
    expect(validateRequestSecurity(request, allowed)).toEqual({ ok: true });
  });
});
