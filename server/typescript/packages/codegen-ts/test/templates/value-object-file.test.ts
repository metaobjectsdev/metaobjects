import { describe, test, expect } from "bun:test";
import {
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_OBJECT,
  OBJECT_SUBTYPE_VALUE,
} from "@metaobjectsdev/metadata";
import { metaObject, metaField } from "../_meta-build.js";
import { renderValueObjectFile } from "../../src/templates/value-object-file.js";

describe("renderValueObjectFile", () => {
  test("emits interface + InsertSchema and NOTHING drizzle/filter-related", () => {
    const wo = metaObject(OBJECT_SUBTYPE_VALUE, "SampleOutput");

    const stance = metaField(FIELD_SUBTYPE_ENUM, "stance");
    stance.setAttr("values", ["supports", "opposes", "abstains"]);
    stance.setAttr("required", true);
    wo.addChild(stance);

    const take = metaField(FIELD_SUBTYPE_STRING, "takeMarkdown");
    take.setAttr("required", true);
    wo.addChild(take);

    const confidence = metaField(FIELD_SUBTYPE_FLOAT, "confidence");
    confidence.setAttr("required", true);
    wo.addChild(confidence);

    const keyClaims = metaField(FIELD_SUBTYPE_STRING, "keyClaims");
    keyClaims.isArray = true;
    keyClaims.setAttr("required", true);
    wo.addChild(keyClaims);

    const citations = metaField(FIELD_SUBTYPE_OBJECT, "citations");
    citations.setAttr("objectRef", "SourceLens");
    citations.isArray = true;
    // required: false (omitted)
    wo.addChild(citations);

    const out = renderValueObjectFile(wo);

    // What IS emitted
    expect(out).toContain("export interface SampleOutput");
    expect(out).toContain("export const SampleOutputInsertSchema");
    expect(out).toContain('export type SampleOutputStance = "supports" | "opposes" | "abstains";');

    // Required field: `name: T` (no ?)
    expect(out).toMatch(/stance:\s*SampleOutputStance;/);
    expect(out).toMatch(/takeMarkdown:\s*string;/);
    expect(out).toMatch(/confidence:\s*number;/);
    expect(out).toMatch(/keyClaims:\s*string\[\];/);

    // Optional field MUST be `name?: T` — not `name?: T | null`. The Zod
    // .optional() inference is `T | undefined`; matching that in the interface
    // lets the residual null-bridge cast in consumer orchestrators collapse.
    expect(out).toMatch(/citations\?:\s*SourceLens\[\];/);
    expect(out).not.toMatch(/citations\?:\s*SourceLens\[\] \| null/);

    // What is NOT emitted (the whole point of the value-only path)
    expect(out).not.toContain("sqliteTable(");
    expect(out).not.toContain("InferSelectModel");
    expect(out).not.toContain("InferInsertModel");
    expect(out).not.toContain("FilterAllowlist");
    expect(out).not.toContain("SortAllowlist");
    expect(out).not.toContain("$table:");
    expect(out).not.toContain("$entity:");
    expect(out).not.toContain("UpdateSchema");
  });

  test("field.object with a FULLY-QUALIFIED @objectRef strips to the bare type + sibling module", () => {
    // Regression: a cross-package @objectRef (acme::ai::SourceLens) must resolve to
    // the BARE short name in BOTH the emitted interface field type and the
    // <Ref>InsertSchema reference — the raw FQN produces an invalid TS identifier
    // (`acme::ai::SourceLens`) and a colon-laden import path.
    const wo = metaObject(OBJECT_SUBTYPE_VALUE, "Brief");
    const citations = metaField(FIELD_SUBTYPE_OBJECT, "citations");
    citations.setAttr("objectRef", "acme::ai::SourceLens");
    citations.isArray = true;
    wo.addChild(citations);

    const out = renderValueObjectFile(wo);
    expect(out).toMatch(/citations\?:\s*SourceLens\[\];/);
    expect(out).toContain("SourceLensInsertSchema");
    expect(out).not.toContain("acme::ai::");
  });

  test("required-field-only value object emits no question marks", () => {
    const sl = metaObject(OBJECT_SUBTYPE_VALUE, "SourceLens");
    for (const name of ["title", "url", "snippet"]) {
      const f = metaField(FIELD_SUBTYPE_STRING, name);
      f.setAttr("required", true);
      sl.addChild(f);
    }
    const out = renderValueObjectFile(sl);
    expect(out).toContain("export interface SourceLens");
    expect(out).not.toMatch(/title\?:/);
    expect(out).not.toMatch(/url\?:/);
    expect(out).not.toMatch(/snippet\?:/);
  });
});
