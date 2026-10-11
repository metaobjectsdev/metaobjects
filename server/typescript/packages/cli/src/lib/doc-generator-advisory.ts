// Advisory: a doc generator listed under `generators` in metaobjects.config.ts.
//
// ADR-0025 made `meta docs` the single docs door, so `meta gen` warns about and skips a
// `docsFile()` / `apiDocsFile()` it finds in the suite. `meta verify --codegen`
// regenerates through that same runner and discards its warnings, so a project wired
// this way verified clean and was never told that the generator it listed produces
// nothing — nor that the gate it was running does not check documentation at all.
//
// Read off the loaded config, not off a regen: the fact is in `generators`, and asking
// the runner's own predicate keeps this from growing a second list of what is skipped.
//
// ADVISORY ONLY, like every row in this tier: nothing here reaches an exit code.

import {
  packagedDocsFactoryCall,
  generatorRegistry,
  isPackagedDocsGenerator,
  DOCS_DOOR_COMMAND,
  type MetaobjectsGenConfig,
} from "@metaobjectsdev/codegen-ts";

/** The file the finding is about. Not a path lookup: the config has exactly one name. */
const CONFIG_FILE = "metaobjects.config.ts";

export interface DocGeneratorFinding {
  file: string;
  /** The command that produces what the wired generator would have. */
  construct: string;
  message: string;
}

/**
 * One finding per doc generator the config wires, in config order.
 *
 * A `generators` entry is a constructed generator or a stable-name string (ADR-0021).
 * A string resolves through the catalog to the same implementation name the runner
 * tests; a name no entry registers is the runner's to refuse, not this scan's.
 */
export function scanForDocGeneratorsInGen(
  config: MetaobjectsGenConfig | undefined,
): DocGeneratorFinding[] {
  const findings: DocGeneratorFinding[] = [];
  for (const spec of config?.generators ?? []) {
    // `spec?.name`: the array is typed, but a config is user code, and a hole in it is
    // the runner's to report rather than a reason for an advisory to throw.
    const implName = typeof spec === "string" ? generatorRegistry[spec]?.factory().name : spec?.name;
    if (implName === undefined || !isPackagedDocsGenerator(implName)) continue;
    const wired = typeof spec === "string" ? `"${spec}"` : packagedDocsFactoryCall(implName);
    findings.push({
      file: CONFIG_FILE,
      construct: DOCS_DOOR_COMMAND,
      message:
        `${CONFIG_FILE}: ${wired} is listed under \`generators\`, and \`meta gen\` skips it — ` +
        `\`${DOCS_DOOR_COMMAND}\` writes documentation and \`meta verify --docs\` checks it. ` +
        `Remove ${wired} from \`generators\`.`,
    });
  }
  return findings;
}
