import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  ValueObject,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { Format, FieldKind, FieldRecovery, orThrow, RecoverError } from "@metaobjectsdev/render";
import { recoverObject, recoverSchemaFor } from "../src/recover-object.js";

// Gold-standard "verdict oracle" proof for the Phase B runtime recover (recoverObject).
//
// A representative adjudication-verdict object.value graph — scalars (incl. an enum with a
// @default), an enum-array, and two arrays-of-records — is recovered from a deliberately DIRTY
// XML response (preamble + whitespace, an empty array, an uncoercible enum value, an omitted
// defaulted field). Proves the full metadata-driven pipeline: recoverSchemaFor → engine →
// assemble into a typed object graph with correct back-references, generalized @default fill,
// empty-array → empty-list, never-throws, and the orThrow() opt-in gate. Mirrors the JVM
// reference MetaObjectRecoverVerdictTest.java (generic verdict fixture — no private names).

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

describe("recoverObject — verdict oracle (dirty XML → typed object graph)", () => {
  test("dirty XML recovers into a typed object graph", async () => {
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

    const result = recoverObject(verdictMo, dirtyXml, Format.XML);

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
    expect(result.report.states().get("arc_transition")).toBe(FieldRecovery.DEFAULTED);

    // ---- enum-array: valid element kept, uncoercible "zzz" dropped (partial recovery) ----
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
    const result = recoverObject(strictMo, "{}", Format.JSON);
    expect(result.report.hasLostRequired()).toBe(true);

    let threw: unknown = null;
    try {
      orThrow(result);
    } catch (e) {
      threw = e;
    }
    expect(threw instanceof RecoverError).toBe(true);
    expect((threw as RecoverError).lostRequired).toContain("needed");
  });

  test("recover never throws on total garbage (and still defaults)", async () => {
    const root = await loadRoot();
    const verdictMo = root.findObject("Verdict")!;

    const result = recoverObject(verdictMo, "%%% not even close %%%");
    expect(result).not.toBeNull();
    const obj = result.data as ValueObject;
    expect(obj).not.toBeNull();
    // arc_transition still defaults even on a degenerate response.
    expect(field(verdictMo, "arc_transition").getValue(obj)).toBe("not_ready");
  });

  test("recoverSchemaFor mirrors the metadata shape", async () => {
    const root = await loadRoot();
    const verdictMo = root.findObject("Verdict")!;

    const schema = recoverSchemaFor(verdictMo, Format.XML);
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
});
