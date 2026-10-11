// Advisory: a doc generator listed under `generators` in metaobjects.config.ts.
//
// ADR-0025 made `meta docs` the single docs door, so `meta gen` warns about and skips a
// `docsFile()` / `apiDocsFile()` it finds in the suite. `meta verify --codegen`
// regenerates through that same runner and discards its warnings, so a project wired
// this way verified clean and was never told that the generator it listed produces
// nothing — nor that the gate it was running does not check documentation at all.
//
// A neutral stable NAME (`"docs"`, `"mermaid-er"`) is a different outcome: `meta gen`
// refuses the string and the run fails, so the finding says refused, not skipped.
//
// Read off the loaded config, not off a regen: the fact is in `generators`, and asking
// the runner's and the resolver's own predicates keeps this from growing a second list
// of what is skipped or refused.
//
// ADVISORY ONLY, like every row in this tier: nothing here reaches an exit code.

import {
  packagedDocsFactoryCall,
  generatorRegistry,
  isNeutralGeneratorName,
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
  /** True when `meta gen` REFUSES the entry (a neutral stable-name string), so the run
   *  fails; false when the runner warns about and skips it. */
  refused: boolean;
  message: string;
}

function finding(wired: string, refused: boolean): DocGeneratorFinding {
  return {
    file: CONFIG_FILE,
    construct: DOCS_DOOR_COMMAND,
    refused,
    message:
      `${CONFIG_FILE}: ${wired} is listed under \`generators\`, and \`meta gen\` ` +
      `${refused ? "refuses it, so the run fails" : "skips it"} — ` +
      `\`${DOCS_DOOR_COMMAND}\` writes documentation and \`meta verify --docs\` checks it. ` +
      `Remove ${wired} from \`generators\`.`,
  };
}

/**
 * One finding per `generators` entry `meta gen` skips or refuses, in config order.
 *
 * A `generators` entry is a constructed generator or a stable-name string (ADR-0021).
 * A neutral name is refused by the resolver. Any other string resolves through the
 * catalog to the same implementation name the runner tests; a name no entry registers
 * is the runner's to refuse, not this scan's.
 */
export function scanForDocGeneratorsInGen(
  config: MetaobjectsGenConfig | undefined,
): DocGeneratorFinding[] {
  const findings: DocGeneratorFinding[] = [];
  for (const spec of config?.generators ?? []) {
    if (typeof spec === "string") {
      if (isNeutralGeneratorName(spec)) findings.push(finding(`"${spec}"`, true));
      else if (isPackagedDocsGenerator(generatorRegistry[spec]?.factory().name ?? "")) {
        findings.push(finding(`"${spec}"`, false));
      }
      continue;
    }
    // `spec?.name`: the array is typed, but a config is user code, and a hole in it is
    // the runner's to report rather than a reason for an advisory to throw.
    const implName = spec?.name;
    if (implName !== undefined && isPackagedDocsGenerator(implName)) {
      findings.push(finding(packagedDocsFactoryCall(implName), false));
    }
  }
  return findings;
}
