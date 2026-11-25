import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { captureTranscript, captureFailure, normalizeTranscript, HOME_PATH, type Capture } from "./transcript.js";

const REPO = resolve(import.meta.dirname, "../..");

// Probe paths are ASSEMBLED, never written as literals. A literal home path in this
// PUBLIC repo trips the pre-commit leak guard on every future edit to this file, and
// a test fixture is not worth a standing --no-verify.
const posixHome = ["", "home", "elsewhere", "x.yaml"].join("/");
const winHome = ["C:", "Users", "elsewhere", "x.yaml"].join("\\");

describe("normalizeTranscript", () => {
  test("rewrites a repo-root path to a repo-relative one", () => {
    expect(normalizeTranscript(`${REPO}/examples/showcase/x.yaml`, REPO))
      .toBe("examples/showcase/x.yaml");
  });

  test("strips a duration so the payload stays deterministic", () => {
    expect(normalizeTranscript("done in 412ms", REPO)).toBe("done in <time>");
  });

  test("THROWS on a home path that is not under the repo root", () => {
    expect(() => normalizeTranscript(posixHome, REPO)).toThrow(/absolute home path/i);
  });

  test("throws on a Windows-style user path too", () => {
    expect(() => normalizeTranscript(winHome, REPO)).toThrow(/absolute home path/i);
  });

  // A leading-boundary requirement would miss all of these, and the payload
  // publishes to a public site.
  test("catches a home path with no preceding whitespace", () => {
    for (const prefix of ["file://", "--cwd=", "[", "'"]) {
      expect(() => normalizeTranscript(prefix + posixHome, REPO))
        .toThrow(/absolute home path/i);
    }
  });

  test("HOME_PATH is exported so the payload sweep uses ONE predicate", () => {
    expect(HOME_PATH.test(posixHome)).toBe(true);
    expect(HOME_PATH.test(winHome)).toBe(true);
    expect(HOME_PATH.test("examples/showcase/x.yaml")).toBe(false);
  });
});

describe("captureTranscript", () => {
  test("the drift fixture really fails, and the failure is the page content", () => {
    const r = captureTranscript(
      ["verify", "--templates", "--prompts", "templates"],
      resolve(REPO, "examples/showcase/drift"));
    expect(r.exitCode).not.toBe(0);
    expect(r.text).toContain("ERR_VAR_NOT_ON_PAYLOAD");
  });

  test("the SHOWCASE passes — the two fixtures are not the same thing", () => {
    const r = captureTranscript(
      ["verify", "--templates", "--prompts", "templates"],
      resolve(REPO, "examples/showcase"));
    expect(r.exitCode).toBe(0);
  });

  test("captured output carries no absolute home path once normalised", () => {
    const r = captureTranscript(
      ["verify", "--templates", "--prompts", "templates"],
      resolve(REPO, "examples/showcase/drift"));
    expect(() => normalizeTranscript(r.text, REPO)).not.toThrow();
  });
});

// A CLI that never ran must not be reported as "the diagnostic changed". Injected
// spawn results, so the cases do not depend on actually starving the machine.
describe("captureFailure", () => {
  const ran: Capture = { text: "ERR_X", exitCode: 1, signal: null, error: undefined };

  test("a capture that ran and failed with output is not a capture failure", () => {
    expect(captureFailure(ran)).toBeNull();
    expect(captureFailure({ ...ran, exitCode: 0, text: "" })).toBeNull();
  });

  test("names the signal when the CLI was killed", () => {
    expect(captureFailure({ ...ran, text: "", signal: "SIGTRAP" }))
      .toBe("the CLI was killed by SIGTRAP; the capture did not run");
  });

  test("names the errno when the CLI failed to spawn", () => {
    const error = Object.assign(new Error("spawn bun EAGAIN"), { code: "EAGAIN" });
    expect(captureFailure({ ...ran, text: "", error }))
      .toBe("the CLI failed to spawn (EAGAIN); the capture did not run");
  });

  test("names the exit status when the CLI exited non-zero with no output", () => {
    expect(captureFailure({ ...ran, text: "", exitCode: 132 }))
      .toBe("the CLI exited 132 with no output; the capture did not run");
  });
});
