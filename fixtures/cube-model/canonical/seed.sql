-- Seed for the cube-model live check (FR-044 Plan 4; server/typescript/packages/integration-tests/
-- cube-live/cube-model.live.ts). Applied after canonical/schema.postgres.sql from
-- fixtures/persistence-conformance/, it fills the three tables the canonical reports read:
-- programs, weeks and assets. The rows are the union of the persistence corpus's report-scenario
-- seeds, plus one week for program 5 (a group with a null label and a short week) and two
-- programs created RELATIVE TO THE DATABASE CLOCK, 3 and 60 days before now(), so the relative
-- `@filter` of RecentPrograms keeps exactly one of them whenever the lane runs. Programs 8-11 are
-- the `introOrFree` segment of LiveIntroPrograms: a DRAFT 'Intro' program and a free PUBLISHED one
-- in its scope, and an ARCHIVED and a 5000-or-more 'Intro' program its `@filter` drops. Each falls
-- on a day, week and month an earlier program already has, so the time-grain reports keep their
-- row counts.
INSERT INTO "programs" ("id","title","priceCents","status","created_ts") VALUES
  (1, 'Foundations', 4999, 'PUBLISHED', '2026-05-01T10:00:00'),
  (2, 'Strength', 2500, 'PUBLISHED', '2026-05-17T23:30:00'),
  (3, 'Mobility', 1000, 'DRAFT', '2026-06-01T00:00:00'),
  (4, 'Legacy', 700, 'ARCHIVED', '2026-05-31T23:59:59'),
  (5, 'Monday', 300, 'PUBLISHED', '2026-05-18T00:00:00'),
  (6, 'Fresh', 1000, 'PUBLISHED', (now() AT TIME ZONE 'UTC') - INTERVAL '3 days'),
  (7, 'Stale', 2000, 'PUBLISHED', (now() AT TIME ZONE 'UTC') - INTERVAL '60 days'),
  (8, 'Intro Flow', 1500, 'DRAFT', '2026-06-01T08:00:00'),
  (9, 'Open Gym', 0, 'PUBLISHED', '2026-05-17T08:00:00'),
  (10, 'Intro Archive', 900, 'ARCHIVED', '2026-05-31T12:00:00'),
  (11, 'Intro Premium', 9000, 'PUBLISHED', '2026-05-01T12:00:00');
INSERT INTO "weeks" ("id","programId","label","durationMinutes","deload") VALUES
  (10, 1, 'Week 1', 30, FALSE),
  (11, 1, 'Week 2', 60, TRUE),
  (12, 1, 'Week 2', 90, FALSE),
  (13, 1, NULL, 60, NULL),
  (20, 2, 'Solo', 45, TRUE),
  (30, 5, NULL, 20, NULL);
INSERT INTO "assets" ("id","ownerId","externalId","payload","recordedAt","observedAt","asOfDate","atTime") VALUES
  ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','{"k": 1}','2026-05-04T03:30:00Z','2026-05-04T03:30:00','2026-05-03','03:30:00'),
  ('33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555','{"k": 2}','2026-05-04T03:45:00Z','2026-05-04T03:45:00','2026-05-03','03:45:00'),
  ('66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777','88888888-8888-4888-8888-888888888888','{"k": 3}','2026-05-04T04:10:00Z','2026-05-04T04:10:00','2026-05-04','04:10:00');
-- The tables the later reports read (FR-044 coverage reports): measurements, sessions, nodes,
-- auths and all_types. Values are the dyadic floats normalization.md requires. The programs and
-- weeks above give the sessions their parents; programs 3-11 have no sessions (spine rows).
INSERT INTO "measurements" ("id","tempC","massKg","preciseKg") VALUES
  (1, 1.5, 8.5, 1.25),
  (2, -2.25, 12.5, 2.5),
  (3, 4.5, 20.25, 0.75),
  (4, 0.5, 7.5, 3.5);
INSERT INTO "sessions" ("id","weekId","minutes") VALUES
  (100, 10, 30),
  (101, 10, 40),
  (102, 11, 50),
  (200, 20, 25);
INSERT INTO "nodes" ("id","label","parentId") VALUES
  (1, 'root', NULL),
  (2, 'a', 1),
  (3, 'b', 1),
  (4, 'c', 2),
  (5, 'top', NULL);
INSERT INTO "auths" ("id","type","reference","quantity","urgency") VALUES
  (1, 'Bridge', 'A-1', 2, NULL),
  (2, 'Bridge', 'A-1', 3, NULL),
  (3, 'Copay', 'C-1', NULL, NULL),
  (4, 'PriorAuth', 'P-1', NULL, NULL),
  (5, 'Referral', 'R-1', NULL, 'routine'),
  (6, 'Referral', 'R-2', NULL, 'urgent'),
  (7, NULL, 'N-1', NULL, NULL);
INSERT INTO "all_types" (
  "id","sVal","iVal","lVal","dVal","fVal","decVal","bVal","dateVal","timeVal","tsVal","tsTzVal",
  "moneyVal","enumVal","intEnumVal","uuidVal","uriVal","inetVal","inet6Val"
) VALUES
  ('00000000-0000-4000-8000-000000000001','r1',10,7,0.5,0.5,1.5,true,'2026-05-01','00:00:00',
   '2026-05-01T00:00:00','2026-05-01T00:00:00Z',1000,'HIGH',5,
   'a1111111-1111-4111-8111-111111111111','urn:x:1','10.0.0.1','fe80::1'),
  ('00000000-0000-4000-8000-000000000002','r2',20,3,0.5,0.5,2.5,true,'2026-05-01','00:00:00',
   '2026-05-01T00:00:00','2026-05-01T00:00:00Z',3000,'HIGH',5,
   'a1111111-1111-4111-8111-111111111111','urn:x:2','10.0.0.2','fe80::2'),
  ('00000000-0000-4000-8000-000000000003','r3',5,9,0.5,0.5,0.5,false,'2026-05-02','00:00:00',
   '2026-05-02T00:00:00','2026-05-02T00:00:00Z',200,'LOW',NULL,
   'b2222222-2222-4222-8222-222222222222','urn:x:3','10.0.0.3','fe80::3'),
  ('00000000-0000-4000-8000-000000000005','r5',99,1,0.5,0.5,9,true,'2026-05-01','00:00:00',
   '2026-05-01T00:00:00','2026-05-01T00:00:00Z',9999,'HIGH',5,
   'a1111111-1111-4111-8111-111111111111','urn:x:5','10.0.0.5','fe80::5');
