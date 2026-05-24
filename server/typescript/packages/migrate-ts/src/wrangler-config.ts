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
 * Walk from `startDir` upward looking for wrangler.toml or wrangler.jsonc.
 * Returns the first match or undefined. wrangler.toml wins over .jsonc at the same level.
 */
export function findWranglerConfig(startDir: string): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    const toml = join(dir, "wrangler.toml");
    if (existsSync(toml)) return toml;
    const jsonc = join(dir, "wrangler.jsonc");
    if (existsSync(jsonc)) return jsonc;
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
  const rawBindings = (obj.d1_databases as unknown[] | undefined) ?? [];
  const d1Bindings: D1Binding[] = rawBindings.map((b) => {
    const r = b as Record<string, unknown>;
    return {
      binding: String(r.binding ?? ""),
      database_name: String(r.database_name ?? ""),
      database_id: String(r.database_id ?? ""),
      migrations_dir: r.migrations_dir !== undefined ? String(r.migrations_dir) : undefined,
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
 * Minimal JSONC parser: strips line comments and block comments,
 * then JSON.parse. Wrangler's jsonc is small; this is sufficient.
 */
function parseJsoncLoose(raw: string): Record<string, unknown> {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(stripped) as Record<string, unknown>;
}
