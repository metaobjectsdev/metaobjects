-- Seed for the cube-model live check (FR-044 Plan 4; server/typescript/packages/integration-tests/
-- cube-live/cube-model.live.ts). Applied after canonical/schema.postgres.sql from
-- fixtures/persistence-conformance/, it fills the three tables the canonical reports read:
-- programs, weeks and assets. The rows are the union of the persistence corpus's report-scenario
-- seeds, plus one week for program 5 (a group with a null label and a short week) and two
-- programs created RELATIVE TO THE DATABASE CLOCK, 3 and 60 days before now(), so the relative
-- `@filter` of RecentPrograms keeps exactly one of them whenever the lane runs.
INSERT INTO "programs" ("id","title","priceCents","status","created_ts") VALUES
  (1, 'Foundations', 4999, 'PUBLISHED', '2026-05-01T10:00:00'),
  (2, 'Strength', 2500, 'PUBLISHED', '2026-05-17T23:30:00'),
  (3, 'Mobility', 1000, 'DRAFT', '2026-06-01T00:00:00'),
  (4, 'Legacy', 700, 'ARCHIVED', '2026-05-31T23:59:59'),
  (5, 'Monday', 300, 'PUBLISHED', '2026-05-18T00:00:00'),
  (6, 'Fresh', 1000, 'PUBLISHED', (now() AT TIME ZONE 'UTC') - INTERVAL '3 days'),
  (7, 'Stale', 2000, 'PUBLISHED', (now() AT TIME ZONE 'UTC') - INTERVAL '60 days');
INSERT INTO "weeks" ("id","programId","label","durationMinutes") VALUES
  (10, 1, 'Week 1', 30),
  (11, 1, 'Week 2', 60),
  (12, 1, 'Week 2', 90),
  (13, 1, NULL, 60),
  (20, 2, 'Solo', 45),
  (30, 5, NULL, 20);
INSERT INTO "assets" ("id","ownerId","externalId","payload","recordedAt","observedAt","asOfDate","atTime") VALUES
  ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','{"k": 1}','2026-05-04T03:30:00Z','2026-05-04T03:30:00','2026-05-03','03:30:00'),
  ('33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555','{"k": 2}','2026-05-04T03:45:00Z','2026-05-04T03:45:00','2026-05-03','03:45:00'),
  ('66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777','88888888-8888-4888-8888-888888888888','{"k": 3}','2026-05-04T04:10:00Z','2026-05-04T04:10:00','2026-05-04','04:10:00');
