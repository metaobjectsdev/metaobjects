// An origin.first whose @via walks more than one hop lowers along that path: the first hop is
// correlated to the base, the rest are INNER-joined inside the subquery.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const MODEL = {
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Patient", children: [
        { "source.rdb": { "@table": "patients" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
      { "object.entity": { name: "Case", children: [
        { "source.rdb": { "@table": "cases" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "patientId" } },
        { "field.long": { name: "programId" } },
        { "field.boolean": { name: "active" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "patient", "@fields": "patientId", "@references": "Patient" } },
      ] } },
      { "object.entity": { name: "Caregiver", children: [
        { "source.rdb": { "@table": "caregivers" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "patientId" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "patient", "@fields": "patientId", "@references": "Patient" } },
      ] } },
      { "object.projection": { name: "CaregiverExtract", children: [
        { "source.rdb": { "@kind": "view", "@table": "v_caregiver_extract" } },
        { "field.long": { name: "id", extends: "Caregiver.id" } },
        { "field.long": { name: "programId", children: [{ "origin.first": {
          "@of": "Case.programId", "@via": "Caregiver.patient.cases", "@orderBy": ["id:desc"], "@filter": { active: true },
        } }] } },
        { "identity.primary": { name: "id", extends: "Caregiver.id" } },
      ] } },
    ],
  },
};

describe("origin.first follows a multi-hop @via", () => {
  test("the column is a subquery along the path, correlated on its first hop", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    expect(errors).toEqual([]);
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toMatch(
      /\(SELECT (\w+)\.program_id FROM patients (\w+) INNER JOIN cases \1 ON \1\.patient_id = \2\.id WHERE \2\.id = c\.patient_id AND \1\.active = TRUE ORDER BY \1\.id DESC NULLS LAST, \1\.id ASC LIMIT 1\) AS program_id/,
    );
    expect([...v!.dependsOn].sort()).toEqual(["caregivers", "cases", "patients"]);
  });
});
