import { describe, it, expect } from "vitest";
import { normalizePeerUrl } from "../src/client/mesh-client.js";

describe("peer URL normalization", () => {
  it("keeps explicit https URLs", () => {
    expect(normalizePeerUrl("https://seed.example.com:9820"))
      .toBe("https://seed.example.com:9820");
  });

  it("adds http scheme for host:port", () => {
    expect(normalizePeerUrl("10.0.0.5:9820")).toBe("http://10.0.0.5:9820");
  });

  it("adds http scheme for hostname:port", () => {
    expect(normalizePeerUrl("seed.internal:9820"))
      .toBe("http://seed.internal:9820");
  });

  it("trims trailing slash", () => {
    expect(normalizePeerUrl("http://seed.internal:9820/"))
      .toBe("http://seed.internal:9820");
  });

  it("throws on empty input", () => {
    expect(() => normalizePeerUrl("   ")).toThrow("Peer URL cannot be empty");
  });
});
