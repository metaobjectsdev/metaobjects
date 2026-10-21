// The assertion engine's number handling: a JSON number must not lose digits unnoticed.

import { describe, expect, test } from "bun:test";
import { assertResponse, parseBodyExact, type ApiRequest } from "../src/api-contract-scenario.ts";

describe("parseBodyExact", () => {
  test("a number a double holds parses as that number", () => {
    expect(parseBodyExact('{"a":1,"b":0.5,"c":-12.25,"d":9007199254740991,"e":1.0,"f":0.10}')).toEqual({
      a: 1, b: 0.5, c: -12.25, d: 9007199254740991, e: 1, f: 0.1,
    });
  });

  test("a number a double cannot hold is marked, not rounded", () => {
    expect(parseBodyExact('{"amount":12345678901234567.89}')).toEqual({ amount: { inexactNumber: "12345678901234567.89" } });
    expect(parseBodyExact("[9007199254740993]")).toEqual([{ inexactNumber: "9007199254740993" }]);
    expect(parseBodyExact("[1e400]")).toEqual([{ inexactNumber: "1e400" }]);
  });

  test("strings are untouched, so an exact decimal string compares as the string it is", () => {
    expect(parseBodyExact('{"amount":"12345678901234567.89"}')).toEqual({ amount: "12345678901234567.89" });
  });
});

describe("assertResponse with an inexact number", () => {
  const req = (equals: unknown): ApiRequest => ({ id: "r1", method: "GET", path: "/x", expect: { status: 200, body: { equals } } });

  test("a number does not equal the string the contract owes", () => {
    expect(() => assertResponse("s", req([{ amount: "0.3" }]), 200, [{ amount: 0.3 }])).toThrow(/mismatch/);
  });

  test("a number beyond a double fails against the double an expectation can spell", () => {
    expect(() => assertResponse("s", req([{ amount: 12345678901234567.89 }]), 200, parseBodyExact('[{"amount":12345678901234567.89}]'))).toThrow(/inexactNumber/);
  });
});
