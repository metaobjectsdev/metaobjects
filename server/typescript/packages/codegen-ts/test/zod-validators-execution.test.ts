// `renderZodValidators` — EXECUTION pins for the field-subtype + validator matrix.
//
// WHY THIS FILE EXISTS. `test/templates/zod-validators.test.ts` covers this same
// emitter with ~390 lines of `toContain` assertions. Those prove the generator
// emitted the string the test author expected; they cannot prove the emitted
// schema COMPILES or BEHAVES. This repo has three named instances of exactly
// that gap:
//
//   • 0.20.6 — `z.string().ip()` for `field.inet`. Removed in Zod 4, so every
//     generated inet validator threw `.ip is not a function`. Text-green.
//   • 0.21.2 — `timestampMode: "date"` emitted `Date`-typed columns against
//     `string`-producing validators. Did not compile. Text-green.
//   • 0.21.2 again — the FIX for the above repaired Postgres and introduced the
//     same class of bug on SQLite. Text-green, because the goldens were
//     regenerated to match the new (wrong) output.
//
// That third case is the important one: a text-asserting suite is WEAKEST
// exactly when a fix lands, because the expected strings get updated to match
// whatever the new emitter produces. So these tests never assert on source
// text. They render the real output, write it to a temp `.ts` file INSIDE this
// package (so bare `"zod"` resolves through the workspace's node_modules),
// dynamically `import()` it, and call the real `safeParse` on the real Zod
// object — asserting on ACCEPT/REJECT of concrete values.
//
// Scope: the semantic pins that a string match structurally cannot check —
// FR-036's full-match regex + non-empty-required + strictest-wins rules, the
// Zod-version-fragile format validators (`field.inet`, `field.uri`,
// `@stringFormat`), and the enum/numeric/array bound chains.
//
// Sibling: `timestamp-mode-execution.test.ts` (same technique, timestampMode).

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  TypeId, TYPE_IDENTITY, TYPE_VALIDATOR,
  IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY,
  FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_ENUM, FIELD_SUBTYPE_URI, FIELD_SUBTYPE_INET,
  FIELD_ATTR_REQUIRED, FIELD_ATTR_MAX_LENGTH, FIELD_ATTR_VALUES,
  FIELD_ATTR_LENIENT, FIELD_ATTR_STRING_FORMAT,
  STRING_FORMAT_EMAIL, STRING_FORMAT_HOSTNAME,
  VALIDATOR_SUBTYPE_LENGTH, VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC, VALIDATOR_SUBTYPE_ARRAY,
  VALIDATOR_ATTR_MIN, VALIDATOR_ATTR_MAX, VALIDATOR_ATTR_PATTERN,
} from "@metaobjectsdev/metadata";
import type { AttrValue, MetaField, MetaObject } from "@metaobjectsdev/metadata";
import { meta, metaObject, metaField } from "./_meta-build.js";
import { renderZodValidators } from "../src/templates/zod-validators.js";

// biome-ignore lint/suspicious/noExplicitAny: dynamically imported generated module — no static shape
type GeneratedModule = Record<string, any>;

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

/**
 * Write a rendered file (imports included — ts-poet's `Code.toString()` hoists
 * them) to a temp `.ts` INSIDE this package so bare specifiers resolve through
 * the workspace node_modules, then dynamically import it. Real execution of the
 * generated module, not a text match.
 */
async function executeGenerated(source: string): Promise<GeneratedModule> {
  const dir = mkdtempSync(join(import.meta.dir, "tmp-zod-exec-"));
  tmpDirs.push(dir);
  const file = join(dir, "schema.ts");
  writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

/** An entity with an auto-increment PK (excluded from Insert/Update) plus `fields`. */
function entityWith(name: string, ...fields: MetaField[]): MetaObject {
  const obj = metaObject(OBJECT_SUBTYPE_ENTITY, name);
  obj.addChild(metaField(FIELD_SUBTYPE_LONG, "id"));
  for (const f of fields) obj.addChild(f);
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  obj.addChild(primary);
  return obj;
}

function validator(subType: string, name: string, attrs: Record<string, AttrValue>) {
  const v = meta(new TypeId(TYPE_VALIDATOR, subType), name);
  for (const [k, val] of Object.entries(attrs)) v.setAttr(k, val);
  return v;
}

/** Render `entity` and return its executed `<Name>InsertSchema`. */
async function insertSchemaOf(entity: MetaObject): Promise<GeneratedModule[string]> {
  const mod = await executeGenerated(renderZodValidators(entity).toString());
  return mod[`${entity.name}InsertSchema`];
}

const accepts = (schema: GeneratedModule[string], value: unknown) =>
  schema.safeParse(value).success;

describe("FR-036 Pin 2 — validator.regex @pattern is FULL-MATCH, not a search", () => {
  // The emitter wraps an authored pattern as `^(?:…)$`. The non-capturing group
  // is load-bearing and a text assertion cannot show why: JS alternation binds
  // loosely, so the "obvious" `^cat|dog$` parses as `(^cat)|(dog$)` and happily
  // accepts "cathouse" and "hotdog". Only executing the emitted RegExp against
  // those values proves the grouping is right.
  test("an alternation pattern rejects values that merely CONTAIN a match", async () => {
    const kind = metaField(FIELD_SUBTYPE_STRING, "kind");
    kind.setAttr(FIELD_ATTR_REQUIRED, true);
    kind.addChild(validator(VALIDATOR_SUBTYPE_REGEX, "kindFormat", {
      [VALIDATOR_ATTR_PATTERN]: "cat|dog",
    }));
    const schema = await insertSchemaOf(entityWith("Pet", kind));

    expect(accepts(schema, { kind: "cat" })).toBe(true);
    expect(accepts(schema, { kind: "dog" })).toBe(true);
    // Would ACCEPT under a naive `^cat|dog$` anchoring — the actual regression.
    expect(accepts(schema, { kind: "cathouse" })).toBe(false);
    expect(accepts(schema, { kind: "hotdog" })).toBe(false);
    expect(accepts(schema, { kind: "xcatx" })).toBe(false);
  });

  test("an already-anchored authored pattern still behaves as full-match (redundant wrap is safe)", async () => {
    const slug = metaField(FIELD_SUBTYPE_STRING, "slug");
    slug.setAttr(FIELD_ATTR_REQUIRED, true);
    slug.addChild(validator(VALIDATOR_SUBTYPE_REGEX, "slugFormat", {
      [VALIDATOR_ATTR_PATTERN]: "^[a-z0-9-]+$",
    }));
    const schema = await insertSchemaOf(entityWith("Post", slug));

    expect(accepts(schema, { slug: "my-post-1" })).toBe(true);
    expect(accepts(schema, { slug: "My Post" })).toBe(false);
    expect(accepts(schema, { slug: "" })).toBe(false);
  });
});

describe("FR-036 Pin 1 — @required string is NON-EMPTY; an explicit @min is authoritative (#224)", () => {
  test('default: a @required string rejects "" and null but ACCEPTS whitespace', async () => {
    const title = metaField(FIELD_SUBTYPE_STRING, "title");
    title.setAttr(FIELD_ATTR_REQUIRED, true);
    const schema = await insertSchemaOf(entityWith("Post", title));

    expect(accepts(schema, { title: "hello" })).toBe(true);
    expect(accepts(schema, { title: "" })).toBe(false);
    expect(accepts(schema, { title: null })).toBe(false);
    expect(accepts(schema, {})).toBe(false);
    // The contract is non-EMPTY, deliberately not non-BLANK: whitespace passes.
    expect(accepts(schema, { title: " " })).toBe(true);
  });

  test('@min:0 restores "must be provided, may be empty" — "" passes, absent still fails', async () => {
    const title = metaField(FIELD_SUBTYPE_STRING, "title");
    title.setAttr(FIELD_ATTR_REQUIRED, true);
    title.addChild(validator(VALIDATOR_SUBTYPE_LENGTH, "titleLen", { [VALIDATOR_ATTR_MIN]: 0 }));
    const schema = await insertSchemaOf(entityWith("Post", title));

    expect(accepts(schema, { title: "" })).toBe(true);
    // Still REQUIRED — the opt-out relaxes emptiness, never presence. A text
    // test for "no .min(1)" cannot distinguish this from dropping required.
    expect(accepts(schema, {})).toBe(false);
    expect(accepts(schema, { title: null })).toBe(false);
  });

  test("an explicit @min above the floor is enforced", async () => {
    const code = metaField(FIELD_SUBTYPE_STRING, "code");
    code.setAttr(FIELD_ATTR_REQUIRED, true);
    code.addChild(validator(VALIDATOR_SUBTYPE_LENGTH, "codeLen", { [VALIDATOR_ATTR_MIN]: 3 }));
    const schema = await insertSchemaOf(entityWith("Item", code));

    expect(accepts(schema, { code: "abc" })).toBe(true);
    expect(accepts(schema, { code: "ab" })).toBe(false);
  });
});

describe("FR-036 A3 — @maxLength × validator.length @max is strictest-wins", () => {
  test("the tighter validator @max wins over a looser field @maxLength", async () => {
    const title = metaField(FIELD_SUBTYPE_STRING, "title");
    title.setAttr(FIELD_ATTR_REQUIRED, true);
    title.setAttr(FIELD_ATTR_MAX_LENGTH, 200);
    title.addChild(validator(VALIDATOR_SUBTYPE_LENGTH, "titleLen", { [VALIDATOR_ATTR_MAX]: 50 }));
    const schema = await insertSchemaOf(entityWith("Post", title));

    expect(accepts(schema, { title: "x".repeat(50) })).toBe(true);
    expect(accepts(schema, { title: "x".repeat(51) })).toBe(false);
  });

  test("the tighter field @maxLength wins over a looser validator @max", async () => {
    const title = metaField(FIELD_SUBTYPE_STRING, "title");
    title.setAttr(FIELD_ATTR_REQUIRED, true);
    title.setAttr(FIELD_ATTR_MAX_LENGTH, 10);
    title.addChild(validator(VALIDATOR_SUBTYPE_LENGTH, "titleLen", { [VALIDATOR_ATTR_MAX]: 500 }));
    const schema = await insertSchemaOf(entityWith("Post", title));

    expect(accepts(schema, { title: "x".repeat(10) })).toBe(true);
    expect(accepts(schema, { title: "x".repeat(11) })).toBe(false);
  });
});

describe("field.inet — the 0.20.6 regression class, executed", () => {
  // `z.string().ip()` was removed in Zod 4; the emitter now builds an explicit
  // regex union (net-regex.ts). Nothing but running it against real literals
  // proves the union still works on the resolved Zod.
  test("accepts IPv4/IPv6 literals and rejects non-literals", async () => {
    const addr = metaField(FIELD_SUBTYPE_INET, "addr");
    addr.setAttr(FIELD_ATTR_REQUIRED, true);
    const schema = await insertSchemaOf(entityWith("Host", addr));

    for (const ok of ["192.168.1.1", "0.0.0.0", "255.255.255.255", "::1", "2001:db8::1"]) {
      expect(accepts(schema, { addr: ok })).toBe(true);
    }
    // H1 (#234 review): a leading-zero octet is octal/decimal-ambiguous — reject,
    // matching Python `ipaddress` and the hand-parsers the other ports emit.
    expect(accepts(schema, { addr: "010.0.0.1" })).toBe(false);
    expect(accepts(schema, { addr: "192.168.01.1" })).toBe(false);
    // Not an address at all / out of range / wrong arity.
    for (const bad of ["256.1.1.1", "1.2.3", "1.2.3.4.5", "", "not-an-ip"]) {
      expect(accepts(schema, { addr: bad })).toBe(false);
    }
    // A literal only — never CIDR, never a hostname (a hostname would imply a
    // DNS lookup on the request path, the bug #234 fixed on the JVM ports).
    expect(accepts(schema, { addr: "192.168.1.1/24" })).toBe(false);
    expect(accepts(schema, { addr: "example.com" })).toBe(false);
  });

  test("H2: IPv4-mapped IPv6 is accepted (cross-port parity with the native address libs)", async () => {
    const addr = metaField(FIELD_SUBTYPE_INET, "addr");
    addr.setAttr(FIELD_ATTR_REQUIRED, true);
    const schema = await insertSchemaOf(entityWith("Host", addr));

    expect(accepts(schema, { addr: "::ffff:192.168.1.1" })).toBe(true);
    expect(accepts(schema, { addr: "2001:db8::1.2.3.4" })).toBe(true);
  });

  test("@lenient binds a plain string — strictness is genuinely opted out, not merely relabelled", async () => {
    const addr = metaField(FIELD_SUBTYPE_INET, "addr");
    addr.setAttr(FIELD_ATTR_REQUIRED, true);
    addr.setAttr(FIELD_ATTR_LENIENT, true);
    const schema = await insertSchemaOf(entityWith("Host", addr));

    expect(accepts(schema, { addr: "example.com" })).toBe(true);
    expect(accepts(schema, { addr: "192.168.1.1/24" })).toBe(true);
  });
});

describe("field.uri — absolute, scheme-bearing only", () => {
  test("accepts absolute URIs (incl. urn:/mailto:) and rejects relative ones", async () => {
    const link = metaField(FIELD_SUBTYPE_URI, "link");
    link.setAttr(FIELD_ATTR_REQUIRED, true);
    const schema = await insertSchemaOf(entityWith("Doc", link));

    for (const ok of ["https://example.com/a?b=c", "http://x.io", "ftp://h/f",
                      "urn:isbn:0451450523", "mailto:a@b.com"]) {
      expect(accepts(schema, { link: ok })).toBe(true);
    }
    // ADR-0036/0037: a URI must be absolute and scheme-bearing.
    for (const bad of ["/relative/path", "example.com", "not a url", ""]) {
      expect(accepts(schema, { link: bad })).toBe(false);
    }
  });

  test("@lenient binds a plain string, so a relative reference passes", async () => {
    const link = metaField(FIELD_SUBTYPE_URI, "link");
    link.setAttr(FIELD_ATTR_REQUIRED, true);
    link.setAttr(FIELD_ATTR_LENIENT, true);
    const schema = await insertSchemaOf(entityWith("Doc", link));

    expect(accepts(schema, { link: "/relative/path" })).toBe(true);
  });
});

describe("@stringFormat — the canonical matcher is codegen-owned", () => {
  test("email accepts a well-formed address and rejects malformed ones", async () => {
    const email = metaField(FIELD_SUBTYPE_STRING, "email");
    email.setAttr(FIELD_ATTR_REQUIRED, true);
    email.setAttr(FIELD_ATTR_STRING_FORMAT, STRING_FORMAT_EMAIL);
    const schema = await insertSchemaOf(entityWith("User", email));

    expect(accepts(schema, { email: "a@b.com" })).toBe(true);
    for (const bad of ["a@b", "a b@c.com", "a@@b.com", "plain", ""]) {
      expect(accepts(schema, { email: bad })).toBe(false);
    }
  });

  test("hostname accepts a DNS name and rejects a URL or a spaced string", async () => {
    const host = metaField(FIELD_SUBTYPE_STRING, "host");
    host.setAttr(FIELD_ATTR_REQUIRED, true);
    host.setAttr(FIELD_ATTR_STRING_FORMAT, STRING_FORMAT_HOSTNAME);
    const schema = await insertSchemaOf(entityWith("Node", host));

    expect(accepts(schema, { host: "example.com" })).toBe(true);
    expect(accepts(schema, { host: "sub.example.co.uk" })).toBe(true);
    for (const bad of ["https://example.com", "not a host", ""]) {
      expect(accepts(schema, { host: bad })).toBe(false);
    }
  });
});

describe("field.enum — membership is enforced, not merely typed", () => {
  test("accepts a declared member and rejects a non-member (case-sensitively)", async () => {
    const status = metaField(FIELD_SUBTYPE_ENUM, "status");
    status.setAttr(FIELD_ATTR_REQUIRED, true);
    status.setAttr(FIELD_ATTR_VALUES, ["DRAFT", "PUBLISHED"]);
    const schema = await insertSchemaOf(entityWith("Order", status));

    expect(accepts(schema, { status: "DRAFT" })).toBe(true);
    expect(accepts(schema, { status: "PUBLISHED" })).toBe(true);
    for (const bad of ["ARCHIVED", "draft", "", null]) {
      expect(accepts(schema, { status: bad })).toBe(false);
    }
  });
});

describe("numeric and array bound chains", () => {
  test("validator.numeric @min/@max bounds an int, and the int-ness itself holds", async () => {
    const qty = metaField(FIELD_SUBTYPE_INT, "qty");
    qty.setAttr(FIELD_ATTR_REQUIRED, true);
    qty.addChild(validator(VALIDATOR_SUBTYPE_NUMERIC, "qtyRange", {
      [VALIDATOR_ATTR_MIN]: 1, [VALIDATOR_ATTR_MAX]: 10,
    }));
    const schema = await insertSchemaOf(entityWith("Line", qty));

    expect(accepts(schema, { qty: 1 })).toBe(true);
    expect(accepts(schema, { qty: 10 })).toBe(true);
    expect(accepts(schema, { qty: 0 })).toBe(false);
    expect(accepts(schema, { qty: 11 })).toBe(false);
    // z.number().int() — a fractional value and a numeric STRING are both rejected.
    expect(accepts(schema, { qty: 5.5 })).toBe(false);
    expect(accepts(schema, { qty: "5" })).toBe(false);
  });

  test("validator.array @min/@max bounds ELEMENT COUNT, not string length", async () => {
    const tags = metaField(FIELD_SUBTYPE_STRING, "tags");
    tags.setAttr(FIELD_ATTR_REQUIRED, true);
    // `isArray` is a NATIVE boolean property, not an attr — setAttr("isArray")
    // would be an ERR_RESERVED_ATTR-shaped mistake and silently leave the field
    // scalar. (Caught by this very test failing on the first run.)
    tags.setIsArray(true);
    tags.addChild(validator(VALIDATOR_SUBTYPE_ARRAY, "tagCount", {
      [VALIDATOR_ATTR_MIN]: 1, [VALIDATOR_ATTR_MAX]: 3,
    }));
    const schema = await insertSchemaOf(entityWith("Post", tags));

    expect(accepts(schema, { tags: ["a"] })).toBe(true);
    expect(accepts(schema, { tags: ["a", "b", "c"] })).toBe(true);
    expect(accepts(schema, { tags: [] })).toBe(false);
    expect(accepts(schema, { tags: ["a", "b", "c", "d"] })).toBe(false);
    // The bounds are on the array, so a long single element is fine — this is
    // the distinction a `.min(1).max(3)` text match cannot make.
    expect(accepts(schema, { tags: ["x".repeat(500)] })).toBe(true);
  });
});
