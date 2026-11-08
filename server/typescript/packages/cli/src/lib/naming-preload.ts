// ADR-0058 Amendment 1 — the dispatcher's pre-step that lets `.metaobjects/config.json` name an
// application-registered naming strategy. Kept apart from load-metaobjects-config.ts so the
// common path (a project on the built-ins) loads no config machinery at all.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_METAOBJECTS_DIR, discoverCollectionRoot } from "@metaobjectsdev/sdk";
import { isRegisteredColumnNamingStrategy, isRegisteredTableNamingRule } from "@metaobjectsdev/metadata";

/** `.metaobjects/config.json`'s basename (the sdk reader's `CONFIG_FILE`). */
const NEUTRAL_CONFIG_FILE = "config.json";
/** The TS codegen config whose `namingStrategies` register the application's strategies. */
const TS_CONFIG_FILE = "metaobjects.config.ts";

/**
 * Registers the project's application naming strategies BEFORE a command reads
 * `.metaobjects/config.json` (ADR-0058 Amendment 1), so a `naming` block can select one by
 * name and the reader can refuse a name nothing answers when it reads the file.
 *
 * Every command discovers and reads `.metaobjects/config.json` before it loads
 * `metaobjects.config.ts` (the order `meta gen` documents, and the one that tolerates a
 * project with no TS config at all). So the dispatcher calls this first. It does nothing —
 * and loads nothing — unless the `naming` block names a strategy no registered strategy
 * answers yet: a project on the built-ins pays one small file read. When it does name one,
 * the nearest `metaobjects.config.ts` is loaded, which registers its `namingStrategies`.
 * A failure to load it is left to the command that loads it for real, which reports it in
 * its own words; if the strategy is still missing, the config reader's refusal names it.
 */
export async function registerProjectNamingStrategies(cwd: string): Promise<void> {
  let configDir: string;
  try {
    const found = await discoverCollectionRoot(cwd);
    if (!found.hasConfig) return;
    configDir = found.dir;
  } catch {
    return;
  }
  let naming: unknown;
  try {
    naming = (JSON.parse(readFileSync(join(configDir, DEFAULT_METAOBJECTS_DIR, NEUTRAL_CONFIG_FILE), "utf8")) as { naming?: unknown }).naming;
  } catch {
    return; // A malformed config is the config reader's to report.
  }
  if (naming === null || typeof naming !== "object") return;
  const { columns, tables } = naming as { columns?: unknown; tables?: unknown };
  const missing =
    (typeof columns === "string" && !isRegisteredColumnNamingStrategy(columns)) ||
    (typeof tables === "string" && !isRegisteredTableNamingRule(tables));
  if (!missing) return;
  const { loadMetaobjectsConfig, resolveGenConfigDir } = await import("./load-metaobjects-config.js");
  const projectRoot = resolveGenConfigDir(cwd, configDir);
  if (!existsSync(join(projectRoot, TS_CONFIG_FILE))) return;
  try {
    await loadMetaobjectsConfig(projectRoot);
  } catch {
    // Reported by the command's own load; the reader names the strategy if it is still missing.
  }
}
