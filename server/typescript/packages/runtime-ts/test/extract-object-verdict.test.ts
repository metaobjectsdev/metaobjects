import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  ValueObject,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { Format, FieldKind, FieldExtraction, orThrow, ExtractError } from "@metaobjectsdev/render";
import { extractObject, extractSchemaFor } from "../src/extract-object.js";

// Gold-standard "verdict oracle" proof for the Phase B runtime extract (extractObject).
//
// A representative adjudication-verdict object.value graph — scalars (incl. an enum with a
// @default), an enum-array, and two arrays-of-records — is extracted from a deliberately DIRTY
// XML response (preamble + whitespace, an empty array, an uncoercible enum value, an omitted
// defaulted field). Proves the full metadata-driven pipeline: extractSchemaFor → engine →
// assemble into a typed object graph with correct back-references, generalized @default fill,
// empty-array → empty-list, never-throws, and the orThrow() opt-in gate. Mirrors the JVM
// reference MetaObjectExtractorVerdictTest.java (generic verdict fixture — no private names).

const PKG = "com::example::verdict";

// A generic adjudication-verdict metamodel (no private/domain names). identifier-safe enum members.
const VERDICT_META = {
  "metadata.root": {
    package: PKG,
    children: [
      {
        "object.value": {
          name: "ThreadCheck",
          children: [
            { "field.string": { name: "id" } },
            { "field.enum": { name: "resolved", "@values": ["yes", "no"] } },
            { "field.string": { name: "reason" } },
          ],
        },
      },
      {
        "object.value": {
          name: "EventCheck",
          children: [
            { "field.string": { name: "id" } },
            { "field.enum": { name: "fires", "@values": ["yes", "no"] } },
            { "field.string": { name: "reason" } },
          ],
        },
      },
      {
        "object.value": {
          name: "Verdict",
          children: [
            { "field.boolean": { name: "objective_complete" } },
            { "field.string": { name: "objective_status" } },
            {
              "field.enum": {
                name: "arc_transition",
                "@values": ["ready", "not_ready"],
                "@default": "not_ready",
              },
            },
            { "field.enum": { name: "tags", isArray: true, "@values": ["a", "b", "c"] } },
            { "field.object": { name: "thread_checks", isArray: true, "@objectRef": `${PKG}::ThreadCheck` } },
            { "field.object": { name: "event_checks", isArray: true, "@objectRef": `${PKG}::EventCheck` } },
          ],
        },
      },
    ],
  },
};

async function loadRoot(): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(VERDICT_META))]);
  expect(res.errors).toEqual([]);
  return res.root;
}

function field(mo: MetaObject, name: string) {
  const f = mo.findField(name);
  if (f === undefined) throw new Error(`no field ${name}`);
  return f;
}

describe("extractObject — verdict oracle (dirty XML → typed object graph)", () => {
  test("dirty XML extracts into a typed object graph", async () => {
    const root = await loadRoot();
    const verdictMo = root.findObject("Verdict")!;
    expect(verdictMo).toBeDefined();

    // Dirty XML: chat preamble + whitespace before the root; arc_transition OMITTED (→ @default
    // "not_ready", DEFAULTED); tags contains an uncoercible member ("zzz") alongside a valid one;
    // event_checks is an EMPTY element (→ empty list, not null); two well-formed thread_checks.
    const dirtyXml =
      "Sure — here is the verdict you asked for:\n\n" +
      "<Verdict>\n" +
      "  <objective_complete>true</objective_complete>\n" +
      "  <objective_status>partially met</objective_status>\n" +
      "  <tags>a</tags>\n" +
      "  <tags>zzz</tags>\n" +
      "  <thread_checks><id>T1</id><resolved>yes</resolved><reason>closed cleanly</reason></thread_checks>\n" +
      "  <thread_checks><id>T2</id><resolved>no</resolved><reason>still open</reason></thread_checks>\n" +
      "  <event_checks></event_checks>\n" +
      "</Verdict>\n" +
      "\nLet me know if you need anything else!";

    const result = extractObject(verdictMo, dirtyXml, Format.XML);

    // ---- never throws; produced a typed Verdict object with the right back-ref ----
    const verdict = result.data as ValueObject;
    expect(verdict).not.toBeNull();
    expect(verdict instanceof ValueObject).toBe(true);
    expect(verdict.getMetaData()).toBe(verdictMo); // back-reference

    // ---- scalars ----
    expect(field(verdictMo, "objective_complete").getValue(verdict)).toBe(true);
    expect(field(verdictMo, "objective_status").getValue(verdict)).toBe("partially met");

    // ---- @default fill: arc_transition was omitted → DEFAULTED to "not_ready" ----
    expect(field(verdictMo, "arc_transition").getValue(verdict)).toBe("not_ready");
    expect(result.report.states().get("arc_transition")).toBe(FieldExtraction.DEFAULTED);

    // ---- enum-array: valid element kept, uncoercible "zzz" dropped (partial extraction) ----
    const tags = field(verdictMo, "tags").getValue(verdict) as unknown[];
    expect(tags).toEqual(["a"]);

    // ---- array-of-records: thread_checks fully populated as typed ValueObject children ----
    const threads = field(verdictMo, "thread_checks").getValue(verdict) as ValueObject[];
    expect(Array.isArray(threads)).toBe(true);
    expect(threads.length).toBe(2);

    const threadMo = root.findObject("ThreadCheck")!;
    const t0 = threads[0]!;
    expect(t0 instanceof ValueObject).toBe(true);
    expect(t0.getMetaData()).toBe(threadMo); // nested back-reference
    expect(field(threadMo, "id").getValue(t0)).toBe("T1");
    expect(field(threadMo, "resolved").getValue(t0)).toBe("yes");
    expect(field(threadMo, "reason").getValue(t0)).toBe("closed cleanly");

    const t1 = threads[1]!;
    expect(field(threadMo, "id").getValue(t1)).toBe("T2");
    expect(field(threadMo, "resolved").getValue(t1)).toBe("no");

    // ---- empty/self-closing array → empty list (NOT null) ----
    const events = field(verdictMo, "event_checks").getValue(verdict) as unknown[];
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBe(0);

    // ---- orThrow(): no required field was lost → returns the data unharmed ----
    const same = orThrow(result);
    expect(same).toBe(verdict);
  });

  test("orThrow throws when a required field was lost", async () => {
    const requiredMeta = {
      "metadata.root": {
        package: PKG,
        children: [
          {
            "object.value": {
              name: "Strict",
              children: [{ "field.string": { name: "needed", "@required": true } }],
            },
          },
        ],
      },
    };
    const res = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(requiredMeta))]);
    expect(res.errors).toEqual([]);
    const strictMo = res.root.findObject("Strict")!;

    // Empty JSON object — "needed" is absent → LOST_REQUIRED.
    const result = extractObject(strictMo, "{}", Format.JSON);
    expect(result.report.hasLostRequired()).toBe(true);

    let threw: unknown = null;
    try {
      orThrow(result);
    } catch (e) {
      threw = e;
    }
    expect(threw instanceof ExtractError).toBe(true);
    expect((threw as ExtractError).lostRequired).toContain("needed");
  });

  test("extract never throws on total garbage (and still defaults)", async () => {
    const root = await loadRoot();
    const verdictMo = root.findObject("Verdict")!;

    const result = extractObject(verdictMo, "%%% not even close %%%");
    expect(result).not.toBeNull();
    const obj = result.data as ValueObject;
    expect(obj).not.toBeNull();
    // arc_transition still defaults even on a degenerate response.
    expect(field(verdictMo, "arc_transition").getValue(obj)).toBe("not_ready");
  });

  test("extractSchemaFor mirrors the metadata shape", async () => {
    const root = await loadRoot();
    const verdictMo = root.findObject("Verdict")!;

    const schema = extractSchemaFor(verdictMo, Format.XML);
    expect(schema.format).toBe(Format.XML);
    expect(schema.rootName).toBe("Verdict");

    const byName = new Map(schema.fields.map((f) => [f.name, f]));

    const arc = byName.get("arc_transition")!;
    expect(arc.kind).toBe(FieldKind.ENUM);
    expect(arc.array).toBe(false);
    expect(arc.defaultValue).toBe("not_ready");
    expect(arc.enumValues).toEqual(["ready", "not_ready"]);

    const tags = byName.get("tags")!;
    expect(tags.kind).toBe(FieldKind.ENUM);
    expect(tags.array).toBe(true);

    const threads = byName.get("thread_checks")!;
    expect(threads.kind).toBe(FieldKind.OBJECT);
    expect(threads.array).toBe(true);
    expect(threads.nested).not.toBeNull();
    expect(threads.nested!.rootName).toBe("ThreadCheck");
  });

  // SP-A close-out: field.decimal extracts as a STRING (its exact-decimal wire form),
  // NOT a lossy DOUBLE — matching the codegen sibling (fr010-field-mapping) + C#.
  test("extractSchemaFor maps field.decimal to STRING (exact, not lossy double)", async () => {
    const meta = {
      "metadata.root": {
        package: "com::example::money",
        children: [
          {
            "object.value": {
              name: "Money",
              children: [
                { "field.decimal": { name: "amount", "@precision": 12, "@scale": 4 } },
                { "field.double": { name: "rate" } },
              ],
            },
          },
        ],
      },
    };
    const res = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(meta))]);
    expect(res.errors).toEqual([]);
    const moneyMo = res.root.findObject("Money")!;

    const schema = extractSchemaFor(moneyMo, Format.JSON);
    const byName = new Map(schema.fields.map((f) => [f.name, f]));
    expect(byName.get("amount")!.kind).toBe(FieldKind.STRING);
    // sanity: double stays DOUBLE — only decimal moved.
    expect(byName.get("rate")!.kind).toBe(FieldKind.DOUBLE);
  });
});
