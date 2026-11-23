// bun:test entry — the generated SERVICE api-contract lane (ADR-0067 layers 4 and 5).
//
// The same corpus as the generated-routes lane, but the server under test is the emitted service
// module (`<pkg>/service/*.ts`: one function per operation, each write in one transaction with the
// model's write rules) behind the emitted thin Fastify transport (`<pkg>/transport/fastify.ts`),
// and again behind its Hono twin (`<pkg>/transport/hono.ts`),
// built with its database at the composition root. Passing it proves moving the rules out of the
// route into a service changed nothing a client can see.

import { describeGeneratedLane } from "../src/api-contract-generated-lane.ts";

describeGeneratedLane("service", "service");
// The same service behind its thin Hono transport.
describeGeneratedLane("service-hono", "service on Hono");
