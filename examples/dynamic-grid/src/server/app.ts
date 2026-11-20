/**
 * The HTTP app: the dynamic routes on the loaded model, under `/api`.
 */
import Fastify, { type FastifyInstance } from "fastify";
import qs from "qs";
import { mountDynamicRoutes, type WriteRule } from "./routes";
import type { Runtime } from "./runtime";

/** Where the collections mount. The browser is told the same value (`baseUrl`). */
export const API_PREFIX = "/api";

export interface AppOptions {
  readonly runtime: Runtime;
  readonly rules?: readonly WriteRule[];
  readonly logger?: boolean;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const fastify = Fastify({
    logger: options.logger ?? false,
    // `filter[status][in]=open,done` is a nested object once parsed; Fastify's own
    // parser would leave the brackets in the key.
    routerOptions: { querystringParser: (query) => qs.parse(query) },
  });
  mountDynamicRoutes({
    fastify,
    prefix: API_PREFIX,
    model: () => options.runtime.current(),
    ...(options.rules !== undefined ? { rules: options.rules } : {}),
  });
  return fastify;
}
