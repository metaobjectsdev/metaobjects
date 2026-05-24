import { existsSync, readFileSync } from "node:fs";
import { dirname, join, isAbsolute, resolve } from "node:path";
import TOML from "@iarna/toml";

export interface D1Binding {
  binding: string;
  database_name: string;
  database_id: string;
  migrations_dir: string | undefined;
}

export interface WranglerConfig {
  d1Bindings: D1Binding[];
}

/**
 * Walk from `startDir` upward looking for wrangler.toml, wrangler.jsonc, or wrangler.json.
 * Returns the first match or undefined. Probe order: toml > jsonc > json at each level,
 * matching wrangler's own resolution order.
 */
export function findWranglerConfig(startDir: string): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    const toml = join(dir, "wrangler.toml");
    if (existsSync(toml)) return toml;
    const jsonc = join(dir, "wrangler.jsonc");
    if (existsSync(jsonc)) return jsonc;
    const json = join(dir, "wrangler.json");
    if (existsSync(json)) return json;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Parse a wrangler.toml or wrangler.jsonc file. Returns extracted D1 bindings.
 */
export function parseWranglerConfig(path: string): WranglerConfig {
  if (!isAbsolute(path)) path = resolve(path);
  const raw = readFileSync(path, "utf8");
  const isJsonc = path.endsWith(".jsonc") || path.endsWith(".json");
  const obj = isJsonc ? parseJsoncLoose(raw) : (TOML.parse(raw) as Record<string, unknown>);
  const rawArr = obj.d1_databases;
  if (rawArr !== undefined && !Array.isArray(rawArr)) {
    throw new Error(`${path}: d1_databases must be an array (got ${typeof rawArr})`);
  }
  const rawBindings: unknown[] = rawArr ?? [];
  const d1Bindings: D1Binding[] = rawBindings.map((b, i) => {
    if (b === null || typeof b !== "object") {
      throw new Error(`${path}: d1_databases[${i}] must be an object`);
    }
    const r = b as Record<string, unknown>;
    if (typeof r.binding !== "string" || r.binding.length === 0) {
      throw new Error(`${path}: d1_databases[${i}] is missing required 'binding' field`);
    }
    return {
      binding: r.binding,
      database_name: typeof r.database_name === "string" ? r.database_name : "",
      database_id: typeof r.database_id === "string" ? r.database_id : "",
      migrations_dir: typeof r.migrations_dir === "string" ? r.migrations_dir : undefined,
    };
  });
  return { d1Bindings };
}

/**
 * Pick a D1 binding by name. If `name` is undefined and there's exactly one
 * binding, return it. Otherwise throw a helpful error.
 */
export function resolveD1Binding(bindings: readonly D1Binding[], name: string | undefined): D1Binding {
  if (bindings.length === 0) {
    throw new Error("no d1 bindings found in wrangler config");
  }
  if (name === undefined) {
    if (bindings.length === 1) return bindings[0]!;
    throw new Error(
      `multiple d1 bindings in wrangler config; pass --d1 <binding>. Available: ${bindings.map((b) => b.binding).join(", ")}`,
    );
  }
  const found = bindings.find((b) => b.binding === name);
  if (!found) {
    throw new Error(
      `d1 binding '${name}' not found in wrangler config. Available: ${bindings.map((b) => b.binding).join(", ")}`,
    );
  }
  return found;
}

/**
 * Minimal JSONC parser: strips `//` line comments and block comments (`/`+`* ... *`+`/`),
 * then JSON.parse. Wrangler's jsonc is small; this is sufficient.
 *
 * Limitation: a `//` sequence inside a JSON string value would be incorrectly
 * stripped. Wrangler's config vocabulary (UUIDs, identifiers, paths) does not
 * use such substrings, so this is acceptable in scope.
 */
function parseJsoncLoose(raw: string): Record<string, unknown> {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(stripped) as Record<string, unknown>;
}
