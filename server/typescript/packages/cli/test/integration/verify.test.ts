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
        "object.value": {
          name: "AuthorBrief",
          children: [
            { "field.string": { name: "displayName" } },
            { "field.int": { name: "postCount" } },
            {
              "field.object": {
                name: "posts",
                "@isArray": true,
                "@objectRef": "PostBrief",
                children: [{ "origin.collection": { "@via": "Author.posts" } }],
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
