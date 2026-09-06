import { describe, expect, test } from "bun:test";
import { joinBaseUrl } from "../src/join-base-url.js";

describe("joinBaseUrl", () => {
  test("no base is the path unchanged", () => {
    expect(joinBaseUrl(undefined, "/customers")).toBe("/customers");
    expect(joinBaseUrl("", "/customers")).toBe("/customers");
  });

  test("a base without a trailing slash concatenates", () => {
    expect(joinBaseUrl("/api", "/customers")).toBe("/api/customers");
  });

  test("a trailing slash on the base does not double", () => {
    expect(joinBaseUrl("/api/", "/customers")).toBe("/api/customers");
  });

  test("a path without a leading slash still gets one separator", () => {
    expect(joinBaseUrl("/api", "customers")).toBe("/api/customers");
    expect(joinBaseUrl("/api/", "customers")).toBe("/api/customers");
  });

  test("an absolute origin is preserved", () => {
    expect(joinBaseUrl("https://api.example.com/v1", "/customers")).toBe(
      "https://api.example.com/v1/customers",
    );
    expect(joinBaseUrl("https://api.example.com/v1/", "/customers")).toBe(
      "https://api.example.com/v1/customers",
    );
  });

  test("the query string rides on the path untouched", () => {
    expect(joinBaseUrl("/api", "/customers?limit=25")).toBe("/api/customers?limit=25");
  });

  test("a bare origin with no path segment still separates", () => {
    expect(joinBaseUrl("https://api.example.com", "/customers")).toBe(
      "https://api.example.com/customers",
    );
  });
});
