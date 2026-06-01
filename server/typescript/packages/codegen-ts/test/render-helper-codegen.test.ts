// template.output render-helper codegen proof (compile-AND-run).
//
// Generates the per-template render helper for a hand-built model, writes the
// emitted .ts (plus a payload interface) to a temp dir, then dynamically
// import()s the emitted module under bun and CALLS the generated function:
//   • document kind  → render<Name>(payload, provider) returns a string.
//   • email kind     → render<Name>(payload, provider) returns an EmailDocument.
// Also proves the BUILD-TIME drift gate: a mustache referencing a field NOT on
// the payload VO makes the generator THROW (fails codegen) with
// ERR_VAR_NOT_ON_PAYLOAD naming the offending field.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { InMemoryProvider, type EmailDocument } from "@metaobjectsdev/render";
import { renderRenderHelper } from "../src/templates/render-helper.js";

const TEMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme::ai", children } })),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

const PAYLOAD_VO = {
  "object.value": {
    name: "WelcomeVO",
    children: [{ "field.string": { name: "name", "@required": true } }],
  },
};

const DOC_MODEL = [
  PAYLOAD_VO,
  {
    "template.output": {
      name: "WelcomePage",
      "@kind": "document",
      "@payloadRef": "WelcomeVO",
      "@textRef": "pages/welcome",
      "@format": "html",
    },
  },
];

const EMAIL_MODEL = [
  PAYLOAD_VO,
  {
    "template.output": {
      name: "WelcomeEmail",
      "@kind": "email",
      "@payloadRef": "WelcomeVO",
      "@subjectRef": "emails/welcome.subject",
      "@htmlBodyRef": "emails/welcome.html",
      "@textBodyRef": "emails/welcome.txt",
    },
  },
];

describe("render-helper codegen — emitted source shape", () => {
  test("document kind emits render<Name>(payload, provider): string", async () => {
    const root = await loadRoot(DOC_MODEL);
    const provider = new InMemoryProvider({ "pages/welcome": "Hello {{name}}" });
    const src = renderRenderHelper(root, "WelcomePage", provider);

    expect(src).toContain('import { render } from "@metaobjectsdev/render";');
    expect(src).toContain('import type { Provider } from "@metaobjectsdev/render";');
    expect(src).toContain("export function renderWelcomePage(payload: WelcomeVO, provider: Provider): string {");
    expect(src).toContain('ref: "pages/welcome"');
    expect(src).toContain('format: "html"');
    expect(src).toContain('verify: [{"name":"name"}]');
    // no email shape
    expect(src).not.toContain("EmailDocument");
    expect(src).not.toContain("subject:");
  });

  test("email kind emits render<Name>(payload, provider): EmailDocument", async () => {
    const root = await loadRoot(EMAIL_MODEL);
    const provider = new InMemoryProvider({
      "emails/welcome.subject": "Welcome {{name}}",
      "emails/welcome.html": "<p>Hi {{name}}</p>",
      "emails/welcome.txt": "Hi {{name}}",
    });
    const src = renderRenderHelper(root, "WelcomeEmail", provider);

    expect(src).toContain('import { render } from "@metaobjectsdev/render";');
    expect(src).toContain("EmailDocument");
    expect(src).toContain("export function renderWelcomeEmail(payload: WelcomeVO, provider: Provider): EmailDocument {");
    expect(src).toContain('subject: render({ ref: "emails/welcome.subject"');
    expect(src).toContain('htmlBody: render({ ref: "emails/welcome.html"');
    expect(src).toContain('textBody: render({ ref: "emails/welcome.txt"');
  });

  test("email kind omits textBody when no @textBodyRef", async () => {
    const root = await loadRoot([
      PAYLOAD_VO,
      {
        "template.output": {
          name: "NoTextEmail",
          "@kind": "email",
          "@payloadRef": "WelcomeVO",
          "@subjectRef": "emails/welcome.subject",
          "@htmlBodyRef": "emails/welcome.html",
        },
      },
    ]);
    const provider = new InMemoryProvider({
      "emails/welcome.subject": "Welcome {{name}}",
      "emails/welcome.html": "<p>Hi {{name}}</p>",
    });
    const src = renderRenderHelper(root, "NoTextEmail", provider);
    expect(src).not.toContain("textBody");
  });
});

describe("render-helper codegen — BUILD-TIME drift gate", () => {
  test("a mustache referencing a field NOT on the payload VO THROWS (fails codegen)", async () => {
    const root = await loadRoot(DOC_MODEL);
    const drifted = new InMemoryProvider({ "pages/welcome": "Hi {{missing}}" });
    expect(() => renderRenderHelper(root, "WelcomePage", drifted)).toThrow(
      /render-helper drift.*WelcomePage.*pages\/welcome.*ERR_VAR_NOT_ON_PAYLOAD.*missing/,
    );
  });

  test("an unresolvable ref THROWS (fails codegen)", async () => {
    const root = await loadRoot(DOC_MODEL);
    const empty = new InMemoryProvider({});
    expect(() => renderRenderHelper(root, "WelcomePage", empty)).toThrow(/render-helper drift.*WelcomePage.*pages\/welcome/);
  });

  test("a clean mustache does NOT throw", async () => {
    const root = await loadRoot(DOC_MODEL);
    const clean = new InMemoryProvider({ "pages/welcome": "Hello {{name}}" });
    expect(() => renderRenderHelper(root, "WelcomePage", clean)).not.toThrow();
  });

  test("a SECTION-context drift ({{#items}}{{bogus}}{{/items}}) THROWS — gate walks nested context", async () => {
    // Nested/array payload: Order { customer: Customer{name}, items: Item[]{sku,qty} }.
    // {{bogus}} is not a field on the Item element type pushed by the {{#items}}
    // section — proving the drift gate walks the section/nested context, not just root.
    const root = await loadRoot([
      { "object.value": { name: "Customer", children: [{ "field.string": { name: "name" } }] } },
      {
        "object.value": {
          name: "Item",
          children: [{ "field.string": { name: "sku" } }, { "field.int": { name: "qty" } }],
        },
      },
      {
        "object.value": {
          name: "Order",
          children: [
            { "field.object": { name: "customer", "@objectRef": "Customer" } },
            { "field.object": { name: "items", isArray: true, "@objectRef": "Item" } },
          ],
        },
      },
      {
        "template.output": {
          name: "OrderEmail",
          "@kind": "email",
          "@payloadRef": "Order",
          "@subjectRef": "emails/order.subject",
          "@htmlBodyRef": "emails/order.html",
        },
      },
    ]);
    const provider = new InMemoryProvider({
      "emails/order.subject": "Order for {{customer.name}}",
      // drift INSIDE the {{#items}} section — {{bogus}} is not on Item.
      "emails/order.html": "<ul>{{#items}}<li>{{bogus}}</li>{{/items}}</ul>",
    });
    expect(() => renderRenderHelper(root, "OrderEmail", provider)).toThrow(
      /render-helper drift.*OrderEmail.*emails\/order\.html.*ERR_VAR_NOT_ON_PAYLOAD.*bogus/,
    );
  });

  test("a clean nested/array template ({{#items}}{{sku}}{{/items}}) does NOT throw", async () => {
    const root = await loadRoot([
      { "object.value": { name: "Customer", children: [{ "field.string": { name: "name" } }] } },
      {
        "object.value": {
          name: "Item",
          children: [{ "field.string": { name: "sku" } }, { "field.int": { name: "qty" } }],
        },
      },
      {
        "object.value": {
          name: "Order",
          children: [
            { "field.object": { name: "customer", "@objectRef": "Customer" } },
            { "field.object": { name: "items", isArray: true, "@objectRef": "Item" } },
          ],
        },
      },
      {
        "template.output": {
          name: "OrderEmail",
          "@kind": "email",
          "@payloadRef": "Order",
          "@subjectRef": "emails/order.subject",
          "@htmlBodyRef": "emails/order.html",
        },
      },
    ]);
    const provider = new InMemoryProvider({
      "emails/order.subject": "Order for {{customer.name}}",
      "emails/order.html": "<h1>{{customer.name}}</h1><ul>{{#items}}<li>{{sku}} x{{qty}}</li>{{/items}}</ul>",
    });
    expect(() => renderRenderHelper(root, "OrderEmail", provider)).not.toThrow();
  });

  test("a drifted EMAIL part-ref THROWS naming the offending part-ref + field", async () => {
    const root = await loadRoot(EMAIL_MODEL);
    const provider = new InMemoryProvider({
      "emails/welcome.subject": "Welcome {{name}}",
      "emails/welcome.html": "<p>Hi {{nope}}</p>", // drift on the html body
      "emails/welcome.txt": "Hi {{name}}",
    });
    expect(() => renderRenderHelper(root, "WelcomeEmail", provider)).toThrow(
      /render-helper drift.*WelcomeEmail.*emails\/welcome\.html.*ERR_VAR_NOT_ON_PAYLOAD.*nope/,
    );
  });
});

describe("render-helper codegen — import-and-RUN proof (bun dynamic import)", () => {
  test("document: renderWelcomePage(payload, provider) returns the rendered string", async () => {
    const root = await loadRoot(DOC_MODEL);
    const provider = new InMemoryProvider({ "pages/welcome": "Hello {{name}}" });
    const src = renderRenderHelper(root, "WelcomePage", provider);

    const dir = mkdtempSync(join(import.meta.dir, "rh-doc-"));
    TEMP_DIRS.push(dir);
    writeFileSync(join(dir, "payloads.ts"), "export interface WelcomeVO { name: string; }\n");
    writeFileSync(join(dir, "WelcomePage.render.ts"), src);

    const mod = await import(join(dir, "WelcomePage.render.ts"));
    const out: string = mod.renderWelcomePage({ name: "Ada" }, provider);
    expect(out).toBe("Hello Ada");
  });

  test("email: renderWelcomeEmail(payload, provider) returns an EmailDocument", async () => {
    const root = await loadRoot(EMAIL_MODEL);
    const provider = new InMemoryProvider({
      "emails/welcome.subject": "Welcome {{name}}",
      "emails/welcome.html": "<p>Hi {{name}}</p>",
      "emails/welcome.txt": "Hi {{name}}",
    });
    const src = renderRenderHelper(root, "WelcomeEmail", provider);

    const dir = mkdtempSync(join(import.meta.dir, "rh-email-"));
    TEMP_DIRS.push(dir);
    writeFileSync(join(dir, "payloads.ts"), "export interface WelcomeVO { name: string; }\n");
    writeFileSync(join(dir, "WelcomeEmail.render.ts"), src);

    const mod = await import(join(dir, "WelcomeEmail.render.ts"));
    const email: EmailDocument = mod.renderWelcomeEmail({ name: "Ada" }, provider);
    expect(email.subject).toBe("Welcome Ada");
    expect(email.htmlBody).toBe("<p>Hi Ada</p>");
    expect(email.textBody).toBe("Hi Ada");
  });
});
