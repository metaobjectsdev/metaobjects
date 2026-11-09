// Phase 5, bug R-walk: an origin's @via may walk the REVERSE of an identity.reference the
// far entity declares, with no relationship declared for it. The hop is named after the
// referencing entity's collection name (lowerFirst(pluralize(<Holder>)), `Patient.consents`
// for Consent.patient). The loader used to refuse it ("no such relationship or reference"),
// though codegen's correlations walk references both ways.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const MODEL = {
  "metadata.root": {
    "package": "acme::care",
    "children": [
      {
        "object.entity": {
          "name": "Patient",
          "children": [
            { "source.rdb": { "@table": "patients" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]
        }
      },
      {
        "object.entity": {
          "name": "Consent",
          "children": [
            { "source.rdb": { "@table": "consents" } },
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "patientId" } },
            { "field.boolean": { "name": "onFile" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "patient", "@fields": "patientId", "@references": "acme::care::Patient" } }
          ]
        }
      },
      {
        "object.projection": {
          "name": "PatientConsentSummary",
          "children": [
            { "source.rdb": { "@kind": "view", "@view": "v_patient_consent_summary" } },
            { "field.long": { "name": "id", "extends": "acme::care::Patient.id" } },
            { "field.int": { "name": "consentCount", "children": [ { "origin.aggregate": { "@agg": "count", "@of": "acme::care::Consent.id", "@via": "acme::care::Patient.consents" } } ] } },
            { "field.boolean": { "name": "latestOnFile", "children": [ { "origin.first": { "@of": "acme::care::Consent.onFile", "@via": "acme::care::Patient.consents", "@orderBy": ["id:desc"] } } ] } },
            { "identity.primary": { "name": "id", "extends": "acme::care::Patient.id" } }
          ]
        }
      }
    ]
  }
};

async function load(model: unknown) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
}

/** The model with a second reference from Consent to Patient: the reverse hop is ambiguous. */
function twoReferences(): unknown {
  const m = JSON.parse(JSON.stringify(MODEL));
  const consent = m["metadata.root"].children[1]["object.entity"].children;
  consent.push({ "field.long": { name: "witnessId" } });
  consent.push({ "identity.reference": { name: "witness", "@fields": "witnessId", "@references": "acme::care::Patient" } });
  return m;
}

describe("R-walk — a @via hop over the reverse of an identity.reference", () => {
  test("loads with no relationship declared", async () => {
    const { errors } = await load(MODEL);
    expect(errors).toEqual([]);
  });

  test("the aggregate joins the referencing table, and the first correlates on its FK", async () => {
    const { root, errors } = await load(MODEL);
    expect(errors).toEqual([]);
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toContain("COUNT(DISTINCT c.id) AS consent_count");
    expect(v!.sql).toContain("LEFT OUTER JOIN public.consents c ON c.patient_id = p.id");
    expect(v!.sql).toMatch(/\(SELECT c0\.on_file FROM public\.consents c0 WHERE c0\.patient_id = p\.id ORDER BY c0\.id DESC NULLS LAST, c0\.id ASC LIMIT 1\) AS latest_on_file/);
  });

  test("two references from the holder make the reverse hop ambiguous, named", async () => {
    const { errors } = await load(twoReferences());
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as { code?: string }).code).toBe("ERR_AMBIGUOUS_PATH");
    expect(String(errors[0]!.message)).toContain('"patient", "witness"');
  });
});
