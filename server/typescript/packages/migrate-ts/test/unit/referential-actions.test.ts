import { describe, expect, test } from "bun:test";
import { resolveReferentialActions } from "../../src/referential-actions.js";
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";

async function loadDoc(doc: unknown) {
  return new MetaDataLoader().load([new InMemorySource(JSON.stringify(doc))]);
}

function weekDoc(rel: Record<string, unknown> | undefined) {
  return { "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Program", children: [
      { "field.long": { name: "id" } },
      { "identity.primary": { "@fields": "id" } },
    ] } },
    { "object.entity": { name: "Week", children: [
      { "field.long": { name: "id" } },
      { "field.long": { name: "programId" } },
      ...(rel ? [rel] : []),
      { "identity.reference": { name: "ref_program", "@fields": ["programId"], "@references": "Program" } },
      { "identity.primary": { "@fields": "id" } },
    ] } },
  ] } };
}

async function loadWeek(rel: Record<string, unknown> | undefined) {
  const { root, errors } = await loadDoc(weekDoc(rel));
  expect(errors).toHaveLength(0);
  const week = root.objects().find((o) => o.name === "Week")!;
  const ref = week.referenceIdentities()[0]!;
  return { week, ref };
}

describe("resolveReferentialActions", () => {
  test("composition → cascade / cascade(default)", async () => {
    const { week, ref } = await loadWeek({
      "relationship.composition": { name: "program", "@objectRef": "Program", "@cardinality": "one" }
    });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "cascade", onUpdate: "cascade" });
  });

  test("aggregation → set-null / cascade(default)", async () => {
    const { week, ref } = await loadWeek({
      "relationship.aggregation": { name: "program", "@objectRef": "Program", "@cardinality": "one" }
    });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "set-null", onUpdate: "cascade" });
  });

  test("association → restrict / cascade(default)", async () => {
    const { week, ref } = await loadWeek({
      "relationship.association": { name: "program", "@objectRef": "Program", "@cardinality": "one" }
    });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "restrict", onUpdate: "cascade" });
  });

  test("explicit override wins; no-action normalizes to undefined", async () => {
    const { week, ref } = await loadWeek({
      "relationship.composition": { name: "program", "@objectRef": "Program",
          "@onDelete": "set-null", "@onUpdate": "no-action" }
    });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "set-null", onUpdate: undefined });
  });

  test("no correlated relationship → both undefined", async () => {
    const { week, ref } = await loadWeek(undefined);
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: undefined, onUpdate: undefined });
  });
});
