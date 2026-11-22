// rules api-contract conformance (GENERATED service lane).
//
// Drives fixtures/api-contract-conformance/rules/ over HTTP against the GENERATED service of a
// model with a lifecycle, declared operations and permission points (ADR-0066), behind its
// emitted Fastify transport (ADR-0067 layers 4 and 5). The corpus's scenarios run under the
// default settings; each `settings/<variant>/` directory runs its own scenarios with its own
// `.metaobjects/config.json` over the same model. Generated lane only — see the corpus README.
// One Postgres testcontainer per scenario (shared per file in the package layout).

import { describe, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTRACT_RULES_DIR, API_CONTRACT_RULES_SCENARIOS_DIR, API_CONTRACT_RULES_SETTINGS_DIR } from "../src/paths.ts";
import { loadScenarios, runScenario } from "../src/api-contract-scenario.ts";
import { OUTPUT_LAYOUTS, postgresFor } from "../src/output-layout.ts";
import { startGeneratedRulesServer, type GeneratedRulesServerHandle, type RulesSeed } from "../src/api-contract-rules-generated-server.ts";

const SEED = JSON.parse(readFileSync(join(API_CONTRACT_RULES_DIR, "seed.json"), "utf8")) as RulesSeed;
const META_PATH = join(API_CONTRACT_RULES_DIR, "meta.json");

const runs: Array<{ label: string; configDir: string; scenariosDir: string }> = [
  { label: "default settings", configDir: API_CONTRACT_RULES_DIR, scenariosDir: API_CONTRACT_RULES_SCENARIOS_DIR },
  ...readdirSync(API_CONTRACT_RULES_SETTINGS_DIR)
    .sort()
    .map((v) => ({ label: `settings/${v}`, configDir: join(API_CONTRACT_RULES_SETTINGS_DIR, v), scenariosDir: join(API_CONTRACT_RULES_SETTINGS_DIR, v, "scenarios") })),
];

for (const layout of OUTPUT_LAYOUTS) describe(`api contract rules — GENERATED service lane [${layout}]`, () => {
  const startDb = postgresFor(layout);
  for (const run of runs) {
    for (const scenario of loadScenarios(run.scenariosDir)) {
      test(`${run.label}: ${scenario.name}`, async () => {
        const pg = await startDb();
        let server: GeneratedRulesServerHandle | null = null;
        try {
          server = await startGeneratedRulesServer(pg.connectionUri, META_PATH, run.configDir, layout);
          await server.applySeed(SEED);
          await runScenario(scenario, server.baseUrl);
        } finally {
          if (server) await server.close();
          await pg.stop();
        }
      }, { timeout: 60_000 });
    }
  }
});
