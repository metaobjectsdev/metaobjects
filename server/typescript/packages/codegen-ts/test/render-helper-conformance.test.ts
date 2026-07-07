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

// Multi-file (multi-package) load — one InMemoryStringSource per file, merged into
// a single root (mirrors fixtures/conformance/loader-same-name-distinct-packages).
async function loadRootFromFiles(...metaJsonPaths: string[]) {
  const sources = metaJsonPaths.map((p) => new InMemoryStringSource(readFileSync(p, "utf-8")));
  const res = await new MetaDataLoader().load(sources);
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

  // Gap 1 — email html SAFETY: the @format=html part escapes markup/XSS, while
  // the @format=text parts (subject, textBody) stay raw. Renders the EXISTING
  // WelcomeEmail with a special-char name; no fixture change. Expected strings
  // are derived from the actual engine output (xml escaper: < > & " ') and pinned.
  test("email WelcomeEmail escapes the html part but leaves text parts raw (XSS safety)", async () => {
    const root = await loadRootFromFile(join(CORPUS, "meta.json"));
    const provider = new FileSystemProvider(join(CORPUS, "templates"));
    const src = renderRenderHelper(root, "WelcomeEmail", provider);

    const dir = mkdtempSync(join(import.meta.dir, "rh-conf-email-xss-"));
    TEMP_DIRS.push(dir);
    writeFileSync(join(dir, "payloads.ts"), "export interface Welcome { name: string; }\n");
    writeFileSync(join(dir, "WelcomeEmail.render.ts"), src);

    const mod = await import(join(dir, "WelcomeEmail.render.ts"));
    const email: EmailDocument = mod.renderWelcomeEmail({ name: "<b>A & Co</b>" }, provider);

    // html part: < > & are entity-escaped → no raw <b> tag can reach a mail client.
    expect(email.htmlBody).toBe("<p>Hi &lt;b&gt;A &amp; Co&lt;/b&gt;</p>");
    expect(email.htmlBody).not.toContain("<b>A");
    // text parts (@format=text): raw, NOT escaped.
    expect(email.subject).toBe("Welcome <b>A & Co</b>");
    expect(email.textBody).toBe("Hi <b>A & Co</b>");
  });

  // Gaps 2 + 3 — nested customer + array-of-items with a {{#items}} section loop,
  // and a {{> shared/footer}} partial in the html body. Proves the field-tree
  // builder + build-time drift gate handle the nested/array shape (clean → no
  // throw) and that section loops + partials render for email.
  test("email OrderEmail renders nested customer + array items loop + partial footer", async () => {
    // The nested/array VOs live in nested/meta.json (a NO-PACKAGE sub-corpus) so a
    // BARE @objectRef resolves by short name identically across ports — isolating the
    // nested/array/partial shape from package resolution. (The fully-qualified @objectRef
    // case is gated separately by xpkg-collision/ below, per ADR-0041.) Both share templates/.
    const root = await loadRootFromFile(join(CORPUS, "nested", "meta.json"));
    const provider = new FileSystemProvider(join(CORPUS, "templates"));
    // The clean nested template must pass the build-time drift gate (no throw).
    const src = renderRenderHelper(root, "OrderEmail", provider);

    const dir = mkdtempSync(join(import.meta.dir, "rh-conf-order-"));
    TEMP_DIRS.push(dir);
    writeFileSync(
      join(dir, "payloads.ts"),
      "export interface Customer { name: string; }\n" +
        "export interface Item { sku: string; qty: number; }\n" +
        "export interface Order { customer: Customer; items: Item[]; }\n",
    );
    writeFileSync(join(dir, "OrderEmail.render.ts"), src);

    const mod = await import(join(dir, "OrderEmail.render.ts"));
    const email: EmailDocument = mod.renderOrderEmail(
      { customer: { name: "Ada" }, items: [{ sku: "A1", qty: 2 }, { sku: "B2", qty: 1 }] },
      provider,
    );

    expect(email.subject).toBe("Order for Ada");
    expect(email.htmlBody).toBe(
      "<h1>Ada</h1><ul><li>A1 x2</li><li>B2 x1</li></ul><hr/>Sent by Acme",
    );
    expect(email.textBody).toBe("Order for Ada: A1 x2; B2 x1;");
    // Gap 3 — the partial resolved into the html body.
    expect(email.htmlBody).toContain("<hr/>Sent by Acme");
  });

  // Cross-package short-name collision (ADR-0041): xpkg-collision/ declares an
  // object.value `Note` in BOTH acme::alpha (field alphaText) and acme::beta (field
  // betaText), and a payload `Digest` whose two field.object children reference them
  // by FULLY-QUALIFIED @objectRef (acme::alpha::Note / acme::beta::Note). A bare-tail
  // resolver strips both refs to `Note` and binds BOTH to whichever package's Note
  // loads first, so exactly one of {{fromAlpha.alphaText}}/{{fromBeta.betaText}} lands
  // on the wrong element type and the build-time drift gate throws ERR_VAR_NOT_ON_PAYLOAD.
  // FQN-exact resolution binds each ref to its own package, so the clean template passes
  // and renders both fields. Render-tier analogue of loader-same-name-distinct-packages.
  test("document DigestDoc resolves FQN nested @objectRef across a cross-package short-name collision", async () => {
    const dirRoot = join(CORPUS, "xpkg-collision");
    const root = await loadRootFromFiles(
      join(dirRoot, "meta.alpha.json"),
      join(dirRoot, "meta.beta.json"),
      join(dirRoot, "meta.app.json"),
    );
    const provider = new FileSystemProvider(join(CORPUS, "templates"));
    // Must NOT throw: the FQN refs resolve to their own package's Note.
    const src = renderRenderHelper(root, "DigestDoc", provider);

    const dir = mkdtempSync(join(import.meta.dir, "rh-conf-xpkg-"));
    TEMP_DIRS.push(dir);
    writeFileSync(
      join(dir, "payloads.ts"),
      "export interface Note { alphaText?: string; betaText?: string; }\n" +
        "export interface Digest { fromAlpha: Note; fromBeta: Note; }\n",
    );
    writeFileSync(join(dir, "DigestDoc.render.ts"), src);

    const mod = await import(join(dir, "DigestDoc.render.ts"));
    const out: string = mod.renderDigestDoc(
      { fromAlpha: { alphaText: "AA" }, fromBeta: { betaText: "BB" } },
      provider,
    );
    expect(out).toBe("Alpha=AA Beta=BB");
  });

  test("drift case THROWS ERR_VAR_NOT_ON_PAYLOAD (fails codegen)", async () => {
    const root = await loadRootFromFile(join(CORPUS, "drift", "meta.json"));
    const provider = new FileSystemProvider(join(CORPUS, "drift", "templates"));
    expect(() => renderRenderHelper(root, "WelcomePage", provider)).toThrow(
      /render-helper drift.*WelcomePage.*pages\/bad.*ERR_VAR_NOT_ON_PAYLOAD.*missing/,
    );
  });
});
