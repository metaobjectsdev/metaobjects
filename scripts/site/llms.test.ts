// The agent-facing mirrors the site serves at metaobjects.dev/llms.txt.
//
// These files are consumed two ways — read directly out of this repo by an agent, and
// served by the website — so they are the one artifact where "correct in the repo" and
// "correct on the site" have historically been different facts. Task 15 makes the site
// copy from here at deploy so there is one maintained copy; these pin the properties that
// copy assumes.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPayload } from "./payload.js";

const REPO = resolve(import.meta.dirname, "../..");
const MIRRORS = ["llms.txt", "llms-full.txt"] as const;
const read = (f: string) => readFileSync(resolve(REPO, "docs/llms", f), "utf8");

describe("llms mirrors", () => {
  for (const f of MIRRORS) {
    test(`docs/llms/${f} exists and is non-trivial`, () => {
      expect(existsSync(resolve(REPO, "docs/llms", f))).toBe(true);
      expect(read(f).length).toBeGreaterThan(1000);
    });
  }

  test("neither mirror contains an absolute home path", () => {
    // The site publishes these verbatim. A leaked home path is the public-repo hygiene
    // rule failing in the one file that is served to the open internet by design.
    for (const f of MIRRORS) expect(read(f)).not.toMatch(/\/(home|Users)\//);
  });

  test("each mirror STATES the shipping versions, so a lagging copy fails", () => {
    // The failure mode this exists for: a release bumps the versions, the mirrors are not
    // refreshed, the site copies them at deploy, and the site lags a release — silently,
    // because the copy succeeds and stale numbers look exactly like fresh ones.
    //
    // Asserted POSITIVELY, and the first draft of this test got it wrong in a way worth
    // recording: it forbade every 0.x/7.x string other than the current one, and failed on
    // `"...were retired in 0.24.0"` — a correct historical sentence. A doc is free to talk
    // about an older release. It is not free to omit the current one, and a mirror that
    // lagged would omit it, because the old number would be sitting where the new one goes.
    //
    // The bound, stated rather than hidden: this passes if a mirror names the current
    // version AND leaves an old shipping claim beside it. Catching that needs a rule for
    // which sentences are claims, which is what produced the false failure above.
    const { npm, maven } = buildPayload(REPO).registries;
    for (const f of MIRRORS) {
      const text = read(f);
      expect({ file: f, npm: text.includes(npm), maven: text.includes(maven) })
        .toEqual({ file: f, npm: true, maven: true });
    }
  });

  test("the one-line summary names both current coordinates", () => {
    // The structural touch-point RELEASING-docs-checklist calls out first, and the line an
    // agent reads before anything else. Pinned separately from the containment check above
    // because "the file mentions 0.24.5 somewhere" and "the summary says we ship 0.24.5"
    // are different claims, and only the second is what a reader acts on.
    const { npm, maven } = buildPayload(REPO).registries;
    for (const f of MIRRORS) {
      const summary = read(f).split("\n").find((l) => l.startsWith("> A cross-language"));
      expect(summary).toBeDefined();
      expect(summary).toContain(npm);
      expect(summary).toContain(maven);
    }
  });
});
