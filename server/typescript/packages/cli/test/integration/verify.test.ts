import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/index.js";

// A view-object payload (AuthorBrief) + a template that renders against it.
const META = {
  "metadata.root": {
    package: "acme::ai",
    children: [
      { "object.value": { name: "PostBrief", children: [{ "field.string": { name: "title" } }] } },
      {
        // Sourceless object.projection host (#210 — a value may host only
        // origin.passthrough). `posts` carried an `origin.collection @via "Author.posts"`
        // until FR-037 R2 retired the subtype (#336); no surviving origin expresses a
        // whole-object rollup (@agg:collect reduces a COLUMN via @of) until #335 lands.
        // What `verify` reads off this payload is declared-authoritative (#270), so it
        // is identical with or without the origin child.
        "object.projection": {
          name: "AuthorBrief",
          children: [
            { "field.string": { name: "displayName" } },
            { "field.int": { name: "postCount" } },
            {
              "field.object": {
                name: "posts",
                "isArray": true,
                "@objectRef": "PostBrief",
              },
            },
          ],
        },
      },
      {
        "template.prompt": {
          name: "contentStrategyPrompt",
          "@payloadRef": "AuthorBrief",
          "@textRef": "prompt/strategy",
          "@format": "xml",
        },
      },
    ],
  },
};

function scaffold(promptText: string | undefined): string {
  const tmp = mkdtempSync(join(tmpdir(), "metaobjects-verify-"));
  mkdirSync(join(tmp, "metaobjects"), { recursive: true });
  writeFileSync(join(tmp, "metaobjects", "meta.ai.json"), JSON.stringify(META), "utf8");
  if (promptText !== undefined) {
    mkdirSync(join(tmp, "prompts", "prompt"), { recursive: true });
    writeFileSync(join(tmp, "prompts", "prompt", "strategy.mustache"), promptText, "utf8");
  }
  return tmp;
}

let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("meta verify", () => {
  test("exit 0 when every template variable resolves against its payload", async () => {
    const tmp = scaffold("Hi {{displayName}}, you have {{postCount}}. {{#posts}}{{title}}{{/posts}}");
    try {
      expect(await run(["verify", "--cwd", tmp])).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("exit 1 and reports ERR_VAR_NOT_ON_PAYLOAD on a drifted variable", async () => {
    const tmp = scaffold("Hi {{displayName}}, you have {{notARealField}}.");
    try {
      expect(await run(["verify", "--cwd", tmp])).toBe(1);
      const all = [...out, ...err].join("\n");
      expect(all).toContain("ERR_VAR_NOT_ON_PAYLOAD");
      expect(all).toContain("notARealField");
      expect(all).toContain("contentStrategyPrompt");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("exit 1 when a template's @textRef cannot be resolved by the provider", async () => {
    const tmp = scaffold(undefined); // no prompt file written
    try {
      expect(await run(["verify", "--cwd", tmp])).toBe(1);
      expect([...out, ...err].join("\n")).toContain("prompt/strategy");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("exit 2 when metaobjects/ is missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-verify-nodir-"));
    try {
      expect(await run(["verify", "--cwd", tmp])).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("exit 1 and reports ERR_OUTPUT_TAG_MISSING when a @requiredTags tag is absent", async () => {
    const metaWithTags = {
      "metadata.root": {
        package: "acme::ai",
        children: [
          { "object.value": { name: "Brief", children: [{ "field.string": { name: "displayName" } }] } },
          {
            "template.prompt": {
              name: "taggedPrompt",
              "@payloadRef": "Brief",
              "@textRef": "prompt/strategy",
              "@requiredTags": ["answer"],
            },
          },
        ],
      },
    };
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-verify-tags-"));
    mkdirSync(join(tmp, "metaobjects"), { recursive: true });
    writeFileSync(join(tmp, "metaobjects", "meta.ai.json"), JSON.stringify(metaWithTags), "utf8");
    mkdirSync(join(tmp, "prompts", "prompt"), { recursive: true });
    // Text references the variable cleanly but omits the contracted <answer> tag.
    writeFileSync(join(tmp, "prompts", "prompt", "strategy.mustache"), "Hi {{displayName}}.", "utf8");
    try {
      expect(await run(["verify", "--cwd", tmp])).toBe(1);
      const all = [...out, ...err].join("\n");
      expect(all).toContain("ERR_OUTPUT_TAG_MISSING");
      expect(all).toContain("answer");
      expect(all).toContain("taggedPrompt");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("advisory anti-pattern pass warns on a hand-rolled aggregate but stays exit 0", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-verify-antipat-"));
    mkdirSync(join(tmp, "metaobjects"), { recursive: true });
    // Minimal metadata with no templates (template gate is a clean no-op → exit 0).
    writeFileSync(
      join(tmp, "metaobjects", "meta.x.json"),
      JSON.stringify({ "metadata.root": { package: "acme::x", children: [] } }),
      "utf8",
    );
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(
      join(tmp, "src", "routes.ts"),
      "const r = await db.execute(`SELECT recipe_id, AVG(value) FROM ratings GROUP BY recipe_id`);",
      "utf8",
    );
    try {
      expect(await run(["verify", "--cwd", tmp])).toBe(0); // advisory never fails
      const all = [...out, ...err].join("\n");
      expect(all).toContain("origin.aggregate");
      expect(all).toContain("meta types origin.aggregate");
      // --no-antipatterns suppresses it
      out.length = 0; err.length = 0;
      expect(await run(["verify", "--cwd", tmp, "--no-antipatterns"])).toBe(0);
      expect([...out, ...err].join("\n")).not.toContain("origin.aggregate");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The two report lines must divide by the SAME thing for the SAME project. They
  // did not: the pass line counted BODIES verified and the failure line counted every
  // template NODE found, skipped ones included. An @kind=email template has two or
  // three bodies and is one template, so it separates the units on its own — and a
  // real project read "11 drift error(s) across 29 template(s)" while red and
  // "22 template(s) clean" once green, seven templates apparently vanishing.
  //
  // Asserting the PAIR is what makes this non-vacuous: the failure half alone was
  // already 1 under the old code. (The other half of the old inflation — a template
  // the loop skips — needs a project-local `template.*` subtype from a provider, the
  // shape that produced the 29-vs-22 above; core vocabulary requires a body on every
  // prompt and email, so it cannot be built from core alone.)
  describe("both report lines divide by the same denominator", () => {
    function scaffoldEmail(htmlBody: string): string {
      const tmp = mkdtempSync(join(tmpdir(), "metaobjects-verify-denom-"));
      mkdirSync(join(tmp, "metaobjects"), { recursive: true });
      writeFileSync(join(tmp, "metaobjects", "meta.ai.json"), JSON.stringify({
        "metadata.root": {
          package: "acme::ai",
          children: [
            { "object.value": { name: "P", children: [{ "field.string": { name: "name" } }] } },
            {
              // ONE template, TWO renderable bodies — the shape that separates the units.
              "template.output": {
                name: "Welcome",
                "@kind": "email",
                "@payloadRef": "P",
                "@subjectRef": "e/subj",
                "@htmlBodyRef": "e/html",
              },
            },
          ],
        },
      }), "utf8");
      mkdirSync(join(tmp, "prompts", "e"), { recursive: true });
      writeFileSync(join(tmp, "prompts", "e", "subj"), "Hello {{name}}", "utf8");
      writeFileSync(join(tmp, "prompts", "e", "html"), htmlBody, "utf8");
      return tmp;
    }

    test("counts TEMPLATES, not bodies, when it passes", async () => {
      const tmp = scaffoldEmail("<p>Hi {{name}}</p>");
      try {
        expect(await run(["verify", "--cwd", tmp])).toBe(0);
        const all = [...out, ...err].join("\n");
        expect(all).toContain("1 template(s) clean");
        expect(all).not.toContain("2 template(s) clean");   // two bodies, one template
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    test("and reports that same 1 when it fails", async () => {
      const tmp = scaffoldEmail("<p>Hi {{nonExistentField}}</p>");
      try {
        expect(await run(["verify", "--cwd", tmp])).toBe(1);
        expect([...out, ...err].join("\n")).toContain("across 1 template(s)");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  test("a custom --prompts dir is honored", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-verify-custom-"));
    mkdirSync(join(tmp, "metaobjects"), { recursive: true });
    writeFileSync(join(tmp, "metaobjects", "meta.ai.json"), JSON.stringify(META), "utf8");
    mkdirSync(join(tmp, "templates", "prompt"), { recursive: true });
    writeFileSync(join(tmp, "templates", "prompt", "strategy.mustache"), "Hi {{displayName}}.", "utf8");
    try {
      expect(await run(["verify", "--cwd", tmp, "--prompts", "templates"])).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
