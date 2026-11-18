// Advisory: generated list routes with no page size.
//
// `api.pagination` in `.metaobjects/config.json` gives every generated list route a default
// page size and a hard cap on `?limit=`. A project that predates it keeps its old behaviour —
// a list with no `limit` returns the whole table, and any `limit` is accepted — because adding
// a cap on upgrade would silently truncate a client that reads a full list. So nothing turns
// it on behind the adopter's back; this names the gap instead. Advisory only: it never reaches
// an exit code.

import { join } from "node:path";
import { DEFAULT_METAOBJECTS_DIR } from "@metaobjectsdev/sdk";

/** The reference route generators whose list endpoints read `api.pagination`. */
export const PAGINATED_ROUTE_GENERATORS: readonly string[] = [
  "routes-file", "routes-file-hono", // the factory names (`routesFile()`, `routesFileHono()`)
  "routes", "routes-hono", // the stable string ids a config may name instead
];

export interface PaginationFinding {
  /** The config file the setting goes in, relative to the project root. */
  file: string;
  /** The wired generator whose list routes are unbounded. */
  generator: string;
  message: string;
}

/**
 * One finding when a route generator that reads `api.pagination` is wired and the project
 * declares none; otherwise none.
 */
export function scanForUnsetPagination(
  generatorNames: readonly string[],
  pagination: unknown,
): PaginationFinding[] {
  if (pagination !== undefined) return [];
  const generator = generatorNames.find((n) => PAGINATED_ROUTE_GENERATORS.includes(n));
  if (generator === undefined) return [];
  const file = join(DEFAULT_METAOBJECTS_DIR, "config.json");
  return [{
    file,
    generator,
    message:
      `${file}: ${generator} is wired and the project sets no api.pagination, so a generated ` +
      `list route with no ?limit= returns the whole table and accepts any ?limit=. Add ` +
      `"api": { "pagination": { "defaultLimit": 50, "maxLimit": 1000 } } to give every list ` +
      `a default page size and answer a larger ?limit= with 400 limit_too_large.`,
  }];
}
