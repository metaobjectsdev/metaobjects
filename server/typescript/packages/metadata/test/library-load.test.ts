import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { librarySources } from "../src/library/library-sources.js";
import { MetaDataLoader } from "../src/index.js";

describe("librarySources", () => {
  test("returns a source for the ai package whose content mentions LlmCallBase", async () => {
    const sources = librarySources(["ai"]);
    expect(sources.length).toBe(1);
    // read() returns Promise<string> per the MetaDataSource contract.
    const text = await sources[0]!.read();
    expect(text).toContain("LlmCallBase");
  });

  test("unknown package yields no sources", () => {
    expect(librarySources(["does-not-exist"]).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// App YAML: one concrete entity that extends the library-shipped abstract base.
// Needs identity.primary to avoid WARN_LEGACY (entity without primary identity).
// ---------------------------------------------------------------------------
const APP_YAML = [
  "metadata:",
  "  package: app::ops",
  "  children:",
  "    - object.entity:",
  "        name: ApiCall",
  "        extends: metaobjects::ai::LlmCallBase",
  "        children:",
  "          - source.rdb: { table: api_call, role: primary }",
  '          - identity.primary: { name: id, fields: ["spanId"] }',
].join("\n");

describe("loader libraries option", () => {
  test("app entity extends a library-shipped abstract base", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-libload-"));
    writeFileSync(join(dir, "meta.app.yaml"), APP_YAML);
    const result = await MetaDataLoader.fromDirectory(dir, { libraries: ["ai"] });
    rmSync(dir, { recursive: true, force: true });

    expect(result.errors).toEqual([]);
    const apiCall = result.root.objects().find((o) => o.name === "ApiCall");
    expect(apiCall).toBeDefined();
    expect(apiCall!.fields().some((f) => f.name === "llmRequest")).toBe(true);
  });

  test("without the libraries option, the same extends is unresolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-libload-no-"));
    writeFileSync(join(dir, "meta.app.yaml"), APP_YAML);
    const result = await MetaDataLoader.fromDirectory(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(result.errors.some((e) => (e as { code?: string }).code === "ERR_UNRESOLVED_SUPER")).toBe(true);
  });
});
