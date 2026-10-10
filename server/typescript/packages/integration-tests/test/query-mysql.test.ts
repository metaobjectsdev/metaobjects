// bun:test entry — the report-* persistence query scenarios on MySQL 8.4.
//
// One MySQL server for the file, the schema artifact re-created per scenario. Requires Docker
// (or METAOBJECTS_TEST_MYSQL_URL). See query-sqlite.test.ts for why only the report scenarios.

import { afterAll, beforeAll, describe, test } from "bun:test";
import { CANONICAL_DIR, QUERIES_DIR } from "../src/paths.ts";
import { loadQueries } from "../src/scenario.ts";
import { runQueryScenarioMysql } from "../src/query-scenario-mysql.ts";
import { startMysql, type MysqlContainerHandle } from "../src/mysql-container.ts";

let container: MysqlContainerHandle;
beforeAll(async () => { container = await startMysql(); }, 240_000);
afterAll(() => { container?.stop(); }, 60_000);

describe("persistence conformance — report query scenarios on MySQL", () => {
  for (const scenario of loadQueries(QUERIES_DIR).filter((s) => s.name.startsWith("report-"))) {
    test(scenario.name, async () => {
      await runQueryScenarioMysql(scenario, container.url, CANONICAL_DIR);
    }, { timeout: 120_000 });
  }
});
