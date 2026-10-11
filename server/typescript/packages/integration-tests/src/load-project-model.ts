// load-project-model.ts — load a real project's metadata the way the `meta` CLI loads it.
//
// `loadMemory(dir)` alone reads the declared sources and opted-in libraries, and nothing else.
// A project that registers its own vocabulary (a `layout.picker`, say) does so through the
// `providers` in its `metaobjects.config.ts`, so a bare load of that project stops at
// `Unknown type`. This reads the config first and hands the providers to `loadMemory`, which
// is what every `meta` command does.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { loadMemory } from "@metaobjectsdev/sdk";
import { loadMemoryOptionsFrom, loadMetaobjectsConfig, resolveGenConfigDir } from "../../cli/src/lib/load-metaobjects-config.ts";

const CONFIG_FILE = "metaobjects.config.ts";

export async function loadProjectModel(projectDir: string): Promise<MetaRoot> {
  const dir = resolve(projectDir);
  // The nearest `metaobjects.config.ts` governs, exactly as it does for `meta gen`.
  const configDir = resolveGenConfigDir(dir, dir);
  const config = existsSync(join(configDir, CONFIG_FILE)) ? await loadMetaobjectsConfig(configDir) : undefined;
  return loadMemory(dir, loadMemoryOptionsFrom(config));
}
