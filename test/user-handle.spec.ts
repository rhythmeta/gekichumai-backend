import { describe, it, expect } from "vitest";
import { sanitizeUsername, buildHandle } from "../src/lib/user-handle.js";
describe("user identity", () => {
  it("normalizes names without losing display spelling", () => {
    expect(sanitizeUsername(" Ａlice ")).toEqual({
      username: "Alice",
      usernameNormalized: "alice",
    });
    expect(buildHandle("Alice", "0001")).toBe("Alice#0001");
  });
  it("rejects invalid names", () => {
    expect(() => sanitizeUsername("a b")).toThrow();
  });
});
