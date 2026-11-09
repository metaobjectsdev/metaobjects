// ADR-0058 Amendment 1 — the dispatcher's pre-step that lets `.metaobjects/config.json` name an
// application-registered naming strategy. Kept apart from load-metaobjects-config.ts so the
// common path (a project on the built-ins) loads no config machinery at all.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_METAOBJECTS_DIR, discoverCollectionRoot } from "@metaobjectsdev/sdk";
import { isRegisteredColumnNamingStrategy, isRegisteredTableNamingRule, isRegisteredPluralizer } from "@metaobjectsdev/metadata";

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
 *
 * Resolves to an error message when that file exists and FAILS to load: the strategy it would
 * have registered is then certainly missing, and the config reader's refusal ("no strategy
 * registered answers it") would send the reader looking for a typo in the name. The caller
 * reports the message, which names both the failed load and the strategy, and stops. Resolves to
 * undefined otherwise; a strategy still missing after a clean load is the reader's to refuse.
 */
export async function registerProjectNamingStrategies(cwd: string): Promise<string | undefined> {
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
  const { columns, tables, collections } = naming as { columns?: unknown; tables?: unknown; collections?: unknown };
  const missing =
    (typeof columns === "string" && !isRegisteredColumnNamingStrategy(columns)) ||
    (typeof tables === "string" && !isRegisteredTableNamingRule(tables)) ||
    (typeof collections === "string" && !isRegisteredPluralizer(collections));
  if (!missing) return;
  const { loadMetaobjectsConfig, resolveGenConfigDir } = await import("./load-metaobjects-config.js");
  const projectRoot = resolveGenConfigDir(cwd, configDir);
  if (!existsSync(join(projectRoot, TS_CONFIG_FILE))) return;
  try {
    await loadMetaobjectsConfig(projectRoot);
  } catch (e) {
    const names = [
      typeof columns === "string" && !isRegisteredColumnNamingStrategy(columns) ? `"${columns}" (naming.columns)` : undefined,
      typeof tables === "string" && !isRegisteredTableNamingRule(tables) ? `"${tables}" (naming.tables)` : undefined,
      typeof collections === "string" && !isRegisteredPluralizer(collections) ? `"${collections}" (naming.collections)` : undefined,
    ].filter((n): n is string => n !== undefined);
    const cause = e instanceof Error ? e.message : String(e);
    const where = `${join(projectRoot, TS_CONFIG_FILE)}: ${TS_CONFIG_FILE} did not load (${cause})`;
    // It may have registered the strategy before it failed: then only the failed load is news.
    if (names.length === 0) return `${where}.`;
    return (
      `${where}, so the naming strategy ${names.join(" and ")} that .metaobjects/config.json names ` +
      `was not registered. Fix the load error: its namingStrategies register the strategy.`
    );
  }
  return undefined;
}
