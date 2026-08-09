import { describe, test, expect } from "bun:test";
import { TypeId, TYPE_IDENTITY, TYPE_VALIDATOR,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_ENUM, FIELD_SUBTYPE_OBJECT,
         FIELD_SUBTYPE_URI, FIELD_SUBTYPE_INET,
         FIELD_ATTR_STRING_FORMAT, STRING_FORMAT_EMAIL, STRING_FORMAT_HOSTNAME,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY,
         VALIDATOR_SUBTYPE_REGEX, VALIDATOR_SUBTYPE_LENGTH,
         MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { meta, metaObject, metaField, metaRoot } from "../_meta-build.js";
import { renderZodValidators } from "../../src/templates/zod-validators.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { FIELD_SUBTYPE_TIMESTAMP } from "@metaobjectsdev/metadata";

describe("renderZodValidators", () => {
  // Reported against an adopting project: a plain field.timestamp (autoSet or not) always got
  // z.string() regardless of timestampMode, disagreeing with a "date"-mode Drizzle column
  // (Date-typed) and failing to typecheck downstream.
  //
  // CRITICAL 1 (post-#281 pre-publish review): z.coerce.date(), not z.date() —
  // these schemas parse raw JSON request bodies (ISO strings on the wire);
  // z.date() rejects every JSON wire value outright. See the execution test
  // below (safeParse against an ISO string) for the behavioral pin.
  test("timestampMode: \"date\" — field.timestamp gets z.coerce.date(), @autoSet gets a Date-returning transform", () => {
    const post = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    post.addChild(id);
    const updatedAt = metaField(FIELD_SUBTYPE_TIMESTAMP, "updatedAt"); // plain, not autoSet
    post.addChild(updatedAt);
    const createdAt = metaField(FIELD_SUBTYPE_TIMESTAMP, "createdAt");
    createdAt.setAttr("required", true);
    createdAt.setAttr("autoSet", "onCreate");
    post.addChild(createdAt);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    post.addChild(primary);

    const root = metaRoot();
    root.addChild(post);
    const ctx = makeRenderContext({
      dialect: "postgres",
      timestampMode: "date",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderZodValidators(post, ctx).toString();
    expect(out).toContain("updatedAt: z.coerce.date()"); // plain field, general zodFieldExpr path
    expect(out).toContain("z.coerce.date().optional().transform(() =>"); // @autoSet insert path
    expect(out).not.toContain("z.date()"); // never the bare (non-coercing) form
    expect(out).not.toContain("z.string()"); // no stale string-typed timestamp anywhere
    expect(out).not.toContain(".toISOString()");
  });
  test("emits InsertSchema with required fields and optional unset fields", () => {
    const post = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    post.addChild(id);
    const title = metaField(FIELD_SUBTYPE_STRING, "title");
    title.setAttr("required", true);
    title.setAttr("maxLength", 200);
    post.addChild(title);
    const body = metaField(FIELD_SUBTYPE_STRING, "body");
    post.addChild(body);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    post.addChild(primary);

    const out = renderZodValidators(post).toString();
    expect(out).toContain("export const PostInsertSchema");
    expect(out).toContain("z.string().min(1).max(200)"); // title: required + maxLength in insert
    expect(out).toContain("z.string().optional()"); // body in insert
    expect(out).toContain("export const PostUpdateSchema");
    // UpdateSchema is now an explicit z.object() with all fields optional
    expect(out).toContain("z.string().min(1).max(200).optional()"); // title in update: optional
    // PK with autoIncrement should NOT appear in InsertSchema or UpdateSchema
    expect(out).not.toContain("id:");
  });

  test("field.enum emits z.enum([...]) with quoted member strings", () => {
    const order = metaObject(OBJECT_SUBTYPE_ENTITY, "Order");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    order.addChild(id);
    const status = metaField(FIELD_SUBTYPE_ENUM, "status");
    status.setAttr("values", ["DRAFT", "PUBLISHED"]);
    order.addChild(status);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    order.addChild(primary);

    const out = renderZodValidators(order).toString();
    expect(out).toContain('z.enum(["DRAFT", "PUBLISHED"])');
    expect(out).not.toContain("z.string()"); // no fallback string type for enum field
  });

  test("field.object with a FULLY-QUALIFIED @objectRef references <Bare>InsertSchema, not the FQN", () => {
    // Regression: a cross-package @objectRef (acme::ai::SourceLens) must resolve to
    // the BARE short name for the <Ref>InsertSchema symbol + its sibling module —
    // the raw FQN emits an invalid `acme::ai::SourceLensInsertSchema` identifier.
    const brief = metaObject(OBJECT_SUBTYPE_ENTITY, "Brief");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    brief.addChild(id);
    const lens = metaField(FIELD_SUBTYPE_OBJECT, "lens");
    lens.setAttr("objectRef", "acme::ai::SourceLens");
    brief.addChild(lens);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    brief.addChild(primary);

    const out = renderZodValidators(brief).toString();
    expect(out).toContain("SourceLensInsertSchema");
    expect(out).not.toContain("acme::ai::");
  });

  test("validator.regex emits a full-match RegExp object (FR-036 Pin 2), not a bare-string search", () => {
    const post = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
    const slug = metaField(FIELD_SUBTYPE_STRING, "slug");
    slug.setAttr("required", true);
    const regex = meta(new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REGEX), "slugFormat");
    // Authored UN-anchored: the emitter must wrap it as ^(?:…)$ so the whole
    // value must match (full-match), not merely contain a match (search).
    regex.setAttr("pattern", "[a-z0-9-]+");
    slug.addChild(regex);
    post.addChild(slug);

    const out = renderZodValidators(post).toString();
    expect(out).toContain('.regex(new RegExp("^(?:[a-z0-9-]+)$"))');
    expect(out).not.toMatch(/\.regex\("[^"]*"\)/); // no bare-string regex argument
  });

  test("FR-036 Pin 1: an explicit validator.length @min:0 is AUTHORITATIVE over the implicit non-empty floor (#224)", () => {
    const post = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
    const title = metaField(FIELD_SUBTYPE_STRING, "title");
    title.setAttr("required", true);
    // An explicitly authored @min:0 says "empty allowed" — the emitter must honor
    // it rather than silently discarding it behind the implicit floor. Until #224
    // every port clamped this to max(@min, 1); the clamp, not the opt-out, was the
    // anomaly: the loader accepts @min:0 and the emitter then dropped it.
    const len = meta(new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_LENGTH), "titleLen");
    len.setAttr("min", 0);
    title.addChild(len);
    post.addChild(title);

    const out = renderZodValidators(post).toString();
    expect(out).not.toContain(".min(1)"); // the floor must NOT be re-imposed
  });

  test("FR-036 Pin 1 default is unchanged: a @required string with NO authored @min still gets the non-empty floor", () => {
    // The regression guard for the change above — opting out must require an
    // explicit @min:0, so the default (nothing authored) still rejects "".
    const post = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
    const title = metaField(FIELD_SUBTYPE_STRING, "title");
    title.setAttr("required", true);
    post.addChild(title);

    const out = renderZodValidators(post).toString();
    expect(out).toContain(".min(1)");
  });

  test("emits JSDoc above InsertSchema + UpdateSchema from entity @description", async () => {
    const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          {
            "object.entity": {
              "name": "User",
              "@description": "A registered account holder.",
              "children": [
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "email" } },
                { "identity.primary": { "name": "id", "@fields": ["id"], "@generation": "increment" } }
              ]
            }
          }
        ]
      }
    }))]);
    expect(result.errors).toEqual([]);
    const user = result.root.objects()[0]!;

    const out = renderZodValidators(user).toString();
    // The one-liner JSDoc form for a single-line description.
    const jsdoc = "/** A registered account holder. */";
    expect(out).toContain(jsdoc);
    expect(out).toContain("export const UserInsertSchema");
    expect(out).toContain("export const UserUpdateSchema");
    // Both schemas get the JSDoc — assert two occurrences.
    const occurrences = out.split(jsdoc).length - 1;
    expect(occurrences).toBe(2);
  });

  test("field.object isArray:true objectRef:Ref emits z.array(RefInsertSchema)", async () => {
    const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          {
            "object.value": {
              "name": "Citation",
              "children": [
                { "field.string": { "name": "url", "@required": true } },
              ],
            },
          },
          {
            "object.value": {
              "name": "Take",
              "children": [
                { "field.string": { "name": "stance", "@required": true } },
                {
                  "field.object": {
                    "name": "citations",
                    "@objectRef": "Citation",
                    "isArray": true,
                    "@required": true,
                  },
                },
              ],
            },
          },
        ],
      },
    }))]);
    expect(result.errors).toEqual([]);
    const take = result.root.objects().find((o) => o.name === "Take")!;
    const out = renderZodValidators(take).toString();
    // The citations field uses CitationInsertSchema as the array element schema —
    // NOT z.string() (the pre-patch bug).
    expect(out).toContain("citations: z.array(CitationInsertSchema)");
    expect(out).not.toContain("citations: z.array(z.string())");
    // ts-poet hoists the cross-module import.
    expect(out).toMatch(/import\s+\{[^}]*CitationInsertSchema[^}]*\}\s+from\s+["']\.\/Citation\.js["']/);
  });

  test("field.object (non-array) objectRef:Ref emits RefInsertSchema bare", async () => {
    const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          {
            "object.value": {
              "name": "Address",
              "children": [{ "field.string": { "name": "city", "@required": true } }],
            },
          },
          {
            "object.value": {
              "name": "Person",
              "children": [
                {
                  "field.object": {
                    "name": "home",
                    "@objectRef": "Address",
                    "@required": true,
                  },
                },
              ],
            },
          },
        ],
      },
    }))]);
    expect(result.errors).toEqual([]);
    const person = result.root.objects().find((o) => o.name === "Person")!;
    const out = renderZodValidators(person).toString();
    expect(out).toContain("home: AddressInsertSchema");
    expect(out).not.toContain("home: z.string()");
    expect(out).toMatch(/import\s+\{[^}]*AddressInsertSchema[^}]*\}\s+from\s+["']\.\/Address\.js["']/);
  });

  test("renderZodValidators does NOT emit `notes` content (D5)", async () => {
    const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          {
            "object.entity": {
              "name": "User",
              "@description": "Public.",
              "@notes": "INTERNAL_SECRET",
              "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "name": "id", "@fields": ["id"], "@generation": "increment" } }
              ]
            }
          }
        ]
      }
    }))]);
    expect(result.errors).toEqual([]);
    const user = result.root.objects()[0]!;

    expect(renderZodValidators(user).toString()).not.toContain("INTERNAL_SECRET");
  });

  test("FR-013: fields with @readOnly: true are excluded from both InsertSchema and UpdateSchema", () => {
    const customer = metaObject(OBJECT_SUBTYPE_ENTITY, "Customer");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    customer.addChild(id);
    const name = metaField(FIELD_SUBTYPE_STRING, "name");
    customer.addChild(name);
    const computedTotal = metaField(FIELD_SUBTYPE_LONG, "lifetimeValue");
    computedTotal.setAttr("readOnly", true);
    customer.addChild(computedTotal);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    customer.addChild(primary);

    const out = renderZodValidators(customer).toString();
    expect(out).toContain("export const CustomerInsertSchema");
    expect(out).toContain("export const CustomerUpdateSchema");
    // FR-013: read-only field appears nowhere in Insert / Update schemas.
    expect(out).not.toContain("lifetimeValue");
  });

  // ADR-0036/0037 Wave 3 + #234 — field.uri / field.inet subtypes + @stringFormat.
  test("field.uri → z.string().url(); field.inet → Zod-version-agnostic IP regex union (not z.string().ip())", () => {
    const ep = metaObject(OBJECT_SUBTYPE_ENTITY, "Endpoint");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    ep.addChild(id);
    ep.addChild(metaField(FIELD_SUBTYPE_URI, "webhookUrl"));
    ep.addChild(metaField(FIELD_SUBTYPE_INET, "sourceIp"));
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    ep.addChild(primary);

    const out = renderZodValidators(ep).toString();
    const compact = out.replace(/\s+/g, "");
    expect(out).toContain("z.string().url()");
    // #234: `z.string().ip()` was REMOVED in Zod 4; codegen emits an explicit
    // IPv4-or-IPv6 regex union that is valid on both Zod 3 and Zod 4.
    expect(out).not.toContain("z.string().ip()");
    expect(compact).toContain(".or(z.string().regex(");
    expect(compact).toContain("z.string().regex(/^(?:(?:25[0-5]"); // the IPv4 octet regex
  });

  // #234 — @lenient degrades field.uri / field.inet to a plain string (no validator).
  test("field.uri @lenient / field.inet @lenient → plain z.string() (no url/ip validator)", () => {
    const ep = metaObject(OBJECT_SUBTYPE_ENTITY, "Endpoint");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    ep.addChild(id);
    const url = metaField(FIELD_SUBTYPE_URI, "citationUrl");
    url.setAttr("lenient", true);
    ep.addChild(url);
    const ip = metaField(FIELD_SUBTYPE_INET, "reportedIp");
    ip.setAttr("lenient", true);
    ep.addChild(ip);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    ep.addChild(primary);

    const out = renderZodValidators(ep).toString();
    // A lenient uri/inet is a plain string — no well-formedness validator emitted.
    expect(out).not.toContain(".url()");
    expect(out).not.toContain(".regex(");
    expect(out).toContain("citationUrl: z.string()");
    expect(out).toContain("reportedIp: z.string()");
  });

  test("field.string @stringFormat: email → z.string().email(); hostname → z.string().regex(...)", () => {
    const ep = metaObject(OBJECT_SUBTYPE_ENTITY, "Contact");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    ep.addChild(id);
    const email = metaField(FIELD_SUBTYPE_STRING, "contactEmail");
    email.setAttr(FIELD_ATTR_STRING_FORMAT, STRING_FORMAT_EMAIL);
    ep.addChild(email);
    const host = metaField(FIELD_SUBTYPE_STRING, "host");
    host.setAttr(FIELD_ATTR_STRING_FORMAT, STRING_FORMAT_HOSTNAME);
    ep.addChild(host);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    ep.addChild(primary);

    const out = renderZodValidators(ep).toString();
    expect(out).toContain("z.string().email()");
    // hostname uses the canonical codegen-owned regex matcher, not author regex
    // (the long literal may be wrapped across lines by the formatter).
    expect(out).toContain("z.string().regex(");
    expect(out.replace(/\s+/g, "")).toContain("z.string().regex(/^(?=.{1,253}$)");
  });
});
