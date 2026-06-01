// Cross-port conformance for the template.output render-helper generator.
//
// Loads the SHARED corpus at fixtures/template-output-render-conformance/ (the
// same meta.json + templates/ the Java port loads, and the oracle the phase-2
// ports — C#/Python/Kotlin — must match) and proves, end-to-end:
//   • document (WelcomePage) → renderWelcomePage({name:"Ada"}, provider) === "Hello Ada"
//   • email    (WelcomeEmail) → { subject:"Welcome Ada", htmlBody:"<p>Hi Ada</p>", textBody:"Hi Ada" }
//   • the drift/ case → codegen THROWS ERR_VAR_NOT_ON_PAYLOAD naming the field/ref/template.
//
// The expected outputs are pinned in the corpus README — this test is the TS
// half of the cross-port oracle (GeneratedRenderHelperConformanceTest is the
// Java half; both assert IDENTICAL strings).

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { type EmailDocument } from "@metaobjectsdev/render";
import { FileSystemProvider } from "../src/render-engine/framework-provider.js";
import { renderRenderHelper } from "../src/templates/render-helper.js";

// test → codegen-ts → packages → typescript → server → repo-root/fixtures
const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/template-output-render-conformance");

const TEMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

async function loadRootFromFile(metaJsonPath: string) {
  const json = readFileSync(metaJsonPath, "utf-8");
  const res = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(res.errors).toEqual([]);
  return res.root;
}

describe("render-helper conformance — shared cross-port corpus", () => {
  test("document WelcomePage renders \"Hello Ada\"", async () => {
    const root = await loadRootFromFile(join(CORPUS, "meta.json"));
    const provider = new FileSystemProvider(join(CORPUS, "templates"));
    const src = renderRenderHelper(root, "WelcomePage", provider);

    const dir = mkdtempSync(join(import.meta.dir, "rh-conf-doc-"));
    TEMP_DIRS.push(dir);
    writeFileSync(join(dir, "payloads.ts"), "export interface Welcome { name: string; }\n");
    writeFileSync(join(dir, "WelcomePage.render.ts"), src);

    const mod = await import(join(dir, "WelcomePage.render.ts"));
    const out: string = mod.renderWelcomePage({ name: "Ada" }, provider);
    expect(out).toBe("Hello Ada");
  });

  test("email WelcomeEmail renders the pinned EmailDocument parts", async () => {
    const root = await loadRootFromFile(join(CORPUS, "meta.json"));
    const provider = new FileSystemProvider(join(CORPUS, "templates"));
    const src = renderRenderHelper(root, "WelcomeEmail", provider);

    const dir = mkdtempSync(join(import.meta.dir, "rh-conf-email-"));
    TEMP_DIRS.push(dir);
    writeFileSync(join(dir, "payloads.ts"), "export interface Welcome { name: string; }\n");
    writeFileSync(join(dir, "WelcomeEmail.render.ts"), src);

    const mod = await import(join(dir, "WelcomeEmail.render.ts"));
    const email: EmailDocument = mod.renderWelcomeEmail({ name: "Ada" }, provider);
    expect(email.subject).toBe("Welcome Ada");
    expect(email.htmlBody).toBe("<p>Hi Ada</p>");
    expect(email.textBody).toBe("Hi Ada");
  });

  test("drift case THROWS ERR_VAR_NOT_ON_PAYLOAD (fails codegen)", async () => {
    const root = await loadRootFromFile(join(CORPUS, "drift", "meta.json"));
    const provider = new FileSystemProvider(join(CORPUS, "drift", "templates"));
    expect(() => renderRenderHelper(root, "WelcomePage", provider)).toThrow(
      /render-helper drift.*WelcomePage.*pages\/bad.*ERR_VAR_NOT_ON_PAYLOAD.*missing/,
    );
  });
});
