// bun:test entry — the GENERATED-routes api-contract lane.
//
// Mirrors api-contract.test.ts (the hand-rolled reference lane) one-for-one,
// but the server under test is the EMITTED Author.routes.ts artifact (Drizzle
// table + Zod schemas + filter/sort allowlists + drizzle-fastify
// mountCrudRoutes), booted over HTTP. Same corpus, same expects → proves the
// deployed artifact implements the cross-port contract, not just the
// golden-snapshot structure.
//
// The lane itself is `src/api-contract-generated-lane.ts`, shared with the service lane.

import { describeGeneratedLane } from "../src/api-contract-generated-lane.ts";

describeGeneratedLane("routes", "routes");
