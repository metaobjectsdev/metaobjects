// rc.19 Phase 6 — the HIPAA-gate shape end to end: a segment.filter on Consent that uses `now`
// (rc.19 `now`), a derived boolean declared ONCE on Patient as origin.first over that segment
// (origin-segment) along the reverse of Consent.patientId (R-walk), and other projections that
// filter on it without outputting it — through a to-one path (entity-derived + G7 joined) or on
// their base. The SQL is built, then run on SQLite against rows that exercise the reset point.

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const MODEL = {
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Patient", children: [
        { "source.rdb": { "@table": "patients" } },
        { "field.long": { name: "id" } },
        { "field.boolean": { name: "hasActiveHipaaConsent", children: [
          { "origin.first": {
            "@via": "Patient.consents", "@of": "Consent.consentIsOnFile",
            "@orderBy": ["id:desc"], "@segment": "hipaaDecisive",
          } },
        ] } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
      { "object.entity": { name: "Consent", children: [
        { "source.rdb": { "@table": "consents" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "patientId", "@required": true } },
        { "field.int": { name: "consentTypeId" } },
        { "field.boolean": { name: "consentIsOnFile" } },
        { "field.boolean": { name: "patientConsent" } },
        { "field.date": { name: "dateReceived" } },
        { "field.date": { name: "effectiveEndDate" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "patientId", "@fields": "patientId", "@references": "Patient" } },
        { "segment.filter": { name: "hipaaDecisive", "@filter": {
          consentTypeId: 1,
          or: [
            { consentIsOnFile: false },
            { and: [
              { consentIsOnFile: true },
              { or: [{ patientConsent: null }, { patientConsent: true }] },
              { dateReceived: { lte: { now: "P0D" } } },
              { or: [{ effectiveEndDate: null }, { effectiveEndDate: { gte: { now: "P0D" } } }] },
            ] },
          ],
        } } },
      ] } },
      { "object.entity": { name: "Case", children: [
        { "source.rdb": { "@table": "cases" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "patientId", "@required": true } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "patientId", "@fields": "patientId", "@references": "Patient" } },
      ] } },
      { "object.entity": { name: "Authorization", children: [
        { "source.rdb": { "@table": "authorizations" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "caseId", "@required": true } },
        { "field.string": { name: "code" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "caseId", "@fields": "caseId", "@references": "Case" } },
      ] } },
      { "object.projection": { name: "AuthorizationExtract", "@filter": { "caseId.patientId.hasActiveHipaaConsent": true }, children: [
        { "source.rdb": { "@kind": "view", "@table": "v_authorization_extract" } },
        { "field.long": { name: "id", extends: "Authorization.id" } },
        { "field.string": { name: "code", extends: "Authorization.code" } },
        { "identity.primary": { name: "id", extends: "Authorization.id" } },
      ] } },
      { "object.projection": { name: "PatientExtract", "@filter": { hasActiveHipaaConsent: true }, children: [
        { "source.rdb": { "@kind": "view", "@table": "v_patient_extract" } },
        { "field.long": { name: "id", extends: "Patient.id" } },
        { "identity.primary": { name: "id", extends: "Patient.id" } },
      ] } },
    ],
  },
};

async function load() {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  expect(result.errors).toEqual([]);
  return result.root;
}

describe("the HIPAA gate: an entity-derived boolean over a segment, used in other projections' @filter", () => {
  test("loads: Patient needs no read source for a derived field projections reach", async () => {
    await load();
  });

  test("the path filter inlines the patient's correlated subquery on the joined patient", async () => {
    const views = buildProjectionViews(await load(), { dialect: "postgres" });
    const auth = views.find((v) => v.name === "v_authorization_extract")!;
    expect(auth.sql).toContain("LEFT OUTER JOIN public.cases c ON c.id = a.case_id");
    expect(auth.sql).toContain("LEFT OUTER JOIN public.patients p ON p.id = c.patient_id");
    // The segment's predicate (with `now` of the date kind) scopes the subquery; it is ordered id:desc.
    expect(auth.sql).toMatch(/WHERE \(\(SELECT (\w+)\.consent_is_on_file FROM public\.consents \1 WHERE \1\.patient_id = p\.id AND \(\1\.consent_type_id = 1 AND/);
    expect(auth.sql).toContain(".date_received <= CAST(((now() AT TIME ZONE 'UTC') + INTERVAL 'P0D') AS DATE)");
    expect(auth.sql).toMatch(/ORDER BY \w+\.id DESC NULLS LAST, \w+\.id ASC LIMIT 1\)\) = TRUE/);
    expect(auth.sql).not.toContain("has_active_hipaa_consent");
    expect(auth.dependsOn).toEqual(expect.arrayContaining(["authorizations", "cases", "patients", "consents"]));
  });

  test("on the base row, the same predicate filters the patients", async () => {
    const views = buildProjectionViews(await load(), { dialect: "postgres" });
    const pat = views.find((v) => v.name === "v_patient_extract")!;
    expect(pat.sql).toMatch(/WHERE \(\(SELECT \w+\.consent_is_on_file FROM public\.consents \w+ WHERE \w+\.patient_id = p\.id/);
  });

  test("runs: the latest decisive row decides, an opt-out resets, future and expired rows do not count", async () => {
    const views = buildProjectionViews(await load(), { dialect: "sqlite" });
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE patients (id INTEGER PRIMARY KEY);
      CREATE TABLE consents (id INTEGER PRIMARY KEY, patient_id INTEGER, consent_type_id INTEGER, consent_is_on_file INTEGER,
        patient_consent INTEGER, date_received TEXT, effective_end_date TEXT);
      CREATE TABLE cases (id INTEGER PRIMARY KEY, patient_id INTEGER);
      CREATE TABLE authorizations (id INTEGER PRIMARY KEY, case_id INTEGER, code TEXT);
    `);
    for (const v of views) db.exec(`CREATE VIEW ${v.name} AS ${v.sql}`);
    // 1: live consent. 2: consent, then an opt-out after it. 3: opt-out, then a consent after it.
    // 4: only a future-dated consent. 5: only an expired consent. 6: a live non-HIPAA consent.
    // 7: live consent with patientConsent = false (refused).
    db.exec(`
      INSERT INTO patients (id) VALUES (1), (2), (3), (4), (5), (6), (7);
      INSERT INTO consents VALUES
        (10, 1, 1, 1, NULL, '2020-01-01', NULL),
        (20, 2, 1, 1, 1, '2020-01-01', NULL), (21, 2, 1, 0, NULL, NULL, NULL),
        (30, 3, 1, 0, NULL, NULL, NULL), (31, 3, 1, 1, 1, '2020-01-01', '2999-01-01'),
        (40, 4, 1, 1, 1, '2999-01-01', NULL),
        (50, 5, 1, 1, 1, '2020-01-01', '2020-06-01'),
        (60, 6, 2, 1, 1, '2020-01-01', NULL),
        (70, 7, 1, 1, 0, '2020-01-01', NULL);
      INSERT INTO cases (id, patient_id) VALUES (100, 1), (200, 2), (300, 3), (400, 4), (500, 5), (600, 6), (700, 7);
      INSERT INTO authorizations (id, case_id, code) VALUES (1000, 100, 'a'), (2000, 200, 'b'), (3000, 300, 'c'),
        (4000, 400, 'd'), (5000, 500, 'e'), (6000, 600, 'f'), (7000, 700, 'g');
    `);
    const ids = (sql: string) => (db.query(sql).all() as { id: number }[]).map((r) => r.id);
    expect(ids("SELECT id FROM v_patient_extract ORDER BY id")).toEqual([1, 3]);
    expect(ids("SELECT id FROM v_authorization_extract ORDER BY id")).toEqual([1000, 3000]);
  });
});
