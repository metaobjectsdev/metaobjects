// `meta docs` was removed in 1.1.0 (ADR-0034 Amendment 9). Documentation is written by the
// generators a project lists in `generators`, which `meta gen` runs and `meta verify
// --codegen` checks: `docsFile()`, `apiDocsFile()`, `requirementsFile()`, `agentDocsFile()`,
// `metamodelDocsFile()` and `docsSiteFile()`. `--scaffold-site` is `meta eject docs-site`.
//
// The command stays only to say so, exiting 2, because "unknown command" names neither the
// replacement nor the migration section. `meta agent-docs` (the agent context) is a different
// command and is unchanged.

import { log } from "../lib/log.js";
import { REMOVED_DOCS_COMMAND } from "../lib/docs-removed.js";

export async function docsCommand(_args: string[], _cwd: string): Promise<number> {
  log.error(REMOVED_DOCS_COMMAND);
  return 2;
}
