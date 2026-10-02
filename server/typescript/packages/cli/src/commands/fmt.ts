// `meta fmt` (#304) — rewrite metadata files into the canonical form the
// cross-port canonical serializer already produces. `--check` lists the
// files that are not canonical and exits non-zero without changing anything.
//
// All of the actual work — file resolution, standalone per-file formatting,
// the YAML skip, and the whole-project reload-and-compare safety check — lives
// in `../lib/fmt-engine.js`, kept framework-free so it is unit-testable without
// spawning the CLI. This module is the thin text/exit-code front end.
import { relative } from "node:path";
import { parseFmtArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { describeError } from "../lib/error-text.js";
import { runFmt, type FmtFileReport } from "../lib/fmt-engine.js";

function describe(report: FmtFileReport, cwd: string, check: boolean): string {
  const rel = relative(cwd, report.path) || report.path;
  switch (report.status) {
    case "formatted":
      return `  reformatted  ${rel}`;
    case "would-format":
      return `  not canonical  ${rel}`;
    case "unchanged":
      return `  ok           ${rel}`;
    case "skipped-yaml":
      return `  skipped (yaml)     ${rel} — ${report.detail}`;
    case "skipped-overlay":
      return `  skipped (overlay)  ${rel} — this file declares an overlay fmt cannot resolve standalone`;
    case "error":
      return `  error        ${rel} — ${report.detail}`;
    default: {
      const _exhaustive: never = report.status;
      return _exhaustive;
    }
  }
}

export async function fmtCommand(args: string[], cwd: string): Promise<number> {
  let flags;
  try {
    flags = parseFmtArgs(args);
  } catch (err) {
    log.error(describeError(err));
    return 2;
  }

  const result = await runFmt({
    projectRoot: cwd,
    check: flags.check,
    files: flags.files,
  });

  if (result.fatal !== undefined) {
    log.error(result.fatal);
    return 1;
  }

  if (result.files.length === 0) {
    log.info("meta fmt — no metadata files to format.");
    return 0;
  }

  for (const report of result.files) {
    log.info(describe(report, cwd, flags.check));
  }

  const errored = result.files.filter((f) => f.status === "error");
  const needsFormat = result.files.filter((f) => f.status === "would-format");
  const reformatted = result.files.filter((f) => f.status === "formatted");

  if (flags.check) {
    if (needsFormat.length > 0 || errored.length > 0) {
      log.error(
        `meta fmt --check — ${needsFormat.length} file(s) not canonical` +
          (errored.length > 0 ? `, ${errored.length} error(s)` : "") +
          `. Run \`meta fmt\` to fix.`,
      );
      return 1;
    }
    log.info("meta fmt --check — every file is already canonical.");
    return 0;
  }

  if (errored.length > 0) {
    log.error(`meta fmt — ${errored.length} file(s) could not be formatted safely (left unchanged).`);
    return 1;
  }

  log.info(`meta fmt — ${reformatted.length} file(s) reformatted.`);
  return 0;
}
