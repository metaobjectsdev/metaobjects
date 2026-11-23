// api-lane.ts — which GENERATED API a sub-corpus harness boots: the flat per-entity routes, or
// the service (ADR-0067 layer 4) behind its thin Fastify or Hono transport (layer 5). The shared
// API tests run on all three, which is what proves that moving the rules out of the route into a
// service changed nothing a client can see, on either framework.

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Context } from "hono";
import { Hono } from "hono";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Generator } from "@metaobjectsdev/codegen-ts";
import { contractTypes, serviceFile, serviceRoutesFile, serviceRoutesHonoFile } from "@metaobjectsdev/codegen-ts/generators";

export type ApiLane = "routes" | "service" | "service-hono";
export const API_LANES: readonly ApiLane[] = ["routes", "service", "service-hono"];

/** What a describe block calls the lane. */
export function laneLabel(lane: ApiLane): string {
  return lane === "routes" ? "GENERATED routes lane" : lane === "service" ? "GENERATED service lane" : "GENERATED service lane on Hono";
}

/**
 * The generators the lane writes its API with. `model` is what both lanes share (the entity
 * module and whatever else the corpus needs); `routes` makes the flat route generators, which the
 * service lane replaces with the contract types, the service and its transport.
 */
export function apiGenerators(
  lane: ApiLane,
  model: Generator[],
  routes: () => Generator[],
  /**
   * The service generator's options: the store (Cloudflare D1 holds no transaction across
   * application code, ADR-0067 §4), and a served report's row cap, which the routes lane gives
   * `routesFile` the same way.
   */
  service: { interactiveTransactions?: boolean; reportMaxRows?: number } = {},
): Generator[] {
  if (lane === "routes") return [...model, ...routes()];
  return [...model, contractTypes(), serviceFile(service), lane === "service" ? serviceRoutesFile() : serviceRoutesHonoFile()];
}

type Factory = (deps: Record<string, unknown>) => unknown;

/** Every emitted `<pkg>/transport/<file>` under `dir`. */
function transports(dir: string, file: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) {
        if (n !== ".metaobjects") walk(f);
      } else if (n === file && d.endsWith("/transport")) out.push(f);
    }
  };
  walk(dir);
  return out.sort();
}

/** For each package the service generator wrote: its transport module and its service built with `deps`. */
async function services(dir: string, file: string, deps: Record<string, unknown>): Promise<Array<{ transport: Record<string, unknown>; service: unknown }>> {
  const found = transports(dir, file);
  if (found.length === 0) throw new Error(`the service lane wrote no transport/${file} under ${dir}`);
  const out: Array<{ transport: Record<string, unknown>; service: unknown }> = [];
  for (const f of found) {
    const transport = (await import(pathToFileURL(f).href)) as Record<string, unknown>;
    const index = (await import(pathToFileURL(join(f, "..", "..", "service", "index.ts")).href)) as Record<string, unknown>;
    const create = Object.entries(index).find(([k]) => /^create\w+Service$/.test(k))?.[1] as Factory | undefined;
    if (create === undefined) throw new Error(`${f}: no service factory beside it`);
    out.push({ transport, service: create(deps) });
  }
  return out;
}

/** The one export of `mod` whose name ends with `suffix`. */
function exported<T>(mod: Record<string, unknown>, suffix: string, where: string): T {
  const found = Object.entries(mod).find(([k]) => k.endsWith(suffix))?.[1];
  if (found === undefined) throw new Error(`${where}: no export named *${suffix}`);
  return found as T;
}

/**
 * What a service lane is built with besides its database: the hand-written dependencies (the
 * policy, the bodies, the hooks, the event hook), and who a request is for, read from its headers.
 * Each transport is handed a `getActor` written against its own framework's request.
 */
export interface ServiceExtras {
  deps?: Record<string, unknown>;
  actor?: (header: (name: string) => string | undefined) => unknown;
}

/**
 * Mount the service lane's API on `fastify`: for each package the generator wrote, build its
 * service with `deps` at the composition root and register its transport with it. The routes hold
 * no database handle of their own. Refuses an output with no transport, so a lane cannot pass on
 * an empty API.
 */
export async function mountServiceApi(
  fastify: FastifyInstance,
  dir: string,
  db: unknown,
  extra: ServiceExtras = {},
): Promise<void> {
  const actor = extra.actor;
  const getActor =
    actor &&
    ((req: FastifyRequest) =>
      actor((name) => {
        const v = req.headers[name];
        return typeof v === "string" ? v : undefined;
      }));
  for (const { transport, service } of await services(dir, "fastify.ts", { db, ...extra.deps })) {
    const plugin = exported<(f: FastifyInstance, opts: unknown) => Promise<void>>(transport, "ServiceRoutes", dir);
    await fastify.register(plugin, { service, getActor });
  }
}

/** A server a harness booted: where it listens, and how to stop it. */
export interface ServedApi {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Boot the lane's API over HTTP. `routes` mounts the flat routes on a Fastify app; the service
 * lanes build each package's service with `db` (and `extra.deps`) and mount its Fastify or Hono
 * transport, resolving the actor with `extra.getActor` when there is one.
 */
export async function serveApi(
  lane: ApiLane,
  dir: string,
  db: unknown,
  mountRoutes: (fastify: FastifyInstance) => Promise<void>,
  extra: ServiceExtras = {},
): Promise<ServedApi> {
  if (lane !== "service-hono") {
    const fastify = Fastify();
    if (lane === "routes") await mountRoutes(fastify);
    else await mountServiceApi(fastify, dir, db, extra);
    await fastify.ready();
    const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });
    return { baseUrl, close: () => fastify.close() };
  }
  const app = new Hono();
  const actor = extra.actor;
  const getActor = actor && ((c: Context) => actor((name) => c.req.header(name)));
  for (const { transport, service } of await services(dir, "hono.ts", { db, ...extra.deps })) {
    const mount = exported<(a: Hono, opts: unknown) => void>(transport, "HonoRoutes", dir);
    mount(app, { service, getActor });
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  return { baseUrl: `http://127.0.0.1:${server.port}`, close: async () => { await server.stop(true); } };
}
