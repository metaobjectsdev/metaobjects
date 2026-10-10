-- MySQL twin of seed.sql, for the MySQL cube-model live check (server/typescript/packages/
-- integration-tests/cube-live/cube-model-mysql.live.ts). Applied after
-- fixtures/persistence-conformance/canonical/schema.mysql.sql. The rows are seed.sql's, spelled
-- for MySQL: DATETIME literals carry no zone designator (the session is UTC), and the two
-- programs created relative to the database clock use UTC_TIMESTAMP(3) so RecentPrograms keeps
-- exactly one of them whenever the lane runs.
INSERT INTO `programs` (`id`,`title`,`priceCents`,`status`,`created_ts`) VALUES
  (1, 'Foundations', 4999, 'PUBLISHED', '2026-05-01 10:00:00'),
  (2, 'Strength', 2500, 'PUBLISHED', '2026-05-17 23:30:00'),
  (3, 'Mobility', 1000, 'DRAFT', '2026-06-01 00:00:00'),
  (4, 'Legacy', 700, 'ARCHIVED', '2026-05-31 23:59:59'),
  (5, 'Monday', 300, 'PUBLISHED', '2026-05-18 00:00:00'),
  (6, 'Fresh', 1000, 'PUBLISHED', UTC_TIMESTAMP(3) - INTERVAL 3 DAY),
  (7, 'Stale', 2000, 'PUBLISHED', UTC_TIMESTAMP(3) - INTERVAL 60 DAY);
INSERT INTO `weeks` (`id`,`programId`,`label`,`durationMinutes`) VALUES
  (10, 1, 'Week 1', 30),
  (11, 1, 'Week 2', 60),
  (12, 1, 'Week 2', 90),
  (13, 1, NULL, 60),
  (20, 2, 'Solo', 45),
  (30, 5, NULL, 20);
INSERT INTO `assets` (`id`,`ownerId`,`externalId`,`payload`,`recordedAt`,`observedAt`,`asOfDate`,`atTime`) VALUES
  ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','{"k": 1}','2026-05-04 03:30:00','2026-05-04 03:30:00','2026-05-03','03:30:00'),
  ('33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555','{"k": 2}','2026-05-04 03:45:00','2026-05-04 03:45:00','2026-05-03','03:45:00'),
  ('66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777','88888888-8888-4888-8888-888888888888','{"k": 3}','2026-05-04 04:10:00','2026-05-04 04:10:00','2026-05-04','04:10:00');
