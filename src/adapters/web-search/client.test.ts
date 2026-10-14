import { describe, expect, it, vi } from "vitest";
import { createWebSearchProvider } from "./client.ts";

describe("general web search", () => {
  it("preserves source evidence and drops duplicate or unsafe links", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [
      { title: "A &amp; B", url: "https://example.org/a?q=x&b=y", content: "Useful <b>evidence</b>" },
      { title: "Duplicate", url: "https://example.org/a?q=x&b=y" },
      { url: "javascript:alert(1)" },
    ] })));
    const result = await createWebSearchProvider({ endpoint: "https://search.example.org/", fetch: request }).search("音乐 & album") as { results: unknown[]; retrieved_at: string };
    expect(result.results).toEqual([{ title: "A & B", url: "https://example.org/a?q=x&b=y", excerpt: "Useful  evidence" }]);
    expect(result.retrieved_at).toBeTruthy();
    expect(new URL(String(request.mock.calls[0]![0])).searchParams.get("q")).toBe("音乐 & album");
  });
  it("uses the configured SearXNG endpoint and bounds evidence size", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: Array.from({ length: 20 }, (_, i) => ({ title: "Title", url: `https://example.org/${i}`, content: "x".repeat(2000) })) })));
    const result = await createWebSearchProvider({ endpoint: "https://search.example.org/", fetch: request }).search("topic") as { results: Array<{ excerpt: string }> };
    const url = new URL(String(request.mock.calls[0]![0]));
    expect(url.pathname).toBe("/search"); expect(url.searchParams.get("format")).toBe("json");
    expect(result.results).toHaveLength(5); expect(result.results[0]!.excerpt).toHaveLength(500);
  });
  it("rejects invalid input before network access", async () => {
    const request = vi.fn<typeof fetch>(); const provider = createWebSearchProvider({ endpoint: "https://search.example.org/", fetch: request });
    await expect(provider.search(" ")).rejects.toThrow("query");
    await expect(provider.search("x".repeat(501))).rejects.toThrow("query");
    await expect(createWebSearchProvider({ endpoint: "file:///etc/passwd", fetch: request }).search("topic")).rejects.toThrow("endpoint");
    expect(request).not.toHaveBeenCalled();
  });
  it("reports unavailable and malformed services instead of fabricated results", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("blocked", { status: 403 })).mockResolvedValueOnce(new Response(JSON.stringify({ not: "results" })));
    const provider = createWebSearchProvider({ endpoint: "https://search.example.org/", fetch: request });
    await expect(provider.search("topic")).rejects.toThrow("403");
    await expect(provider.search("topic")).rejects.toThrow("Invalid search response");
  });
  it("returns an empty successful result honestly", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    expect(await createWebSearchProvider({ endpoint: "https://search.example.org/", fetch: request }).search("unknown")).toMatchObject({ results: [] });
  });
});
