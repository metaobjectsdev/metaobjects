import { parseArgs, type ParseArgsConfig } from "node:util";

/**
 * The flags every command accepts beyond its own table. `--cwd` and `--format` are
 * stripped by the dispatcher before a command parses anything, and `--help` is
 * answered there too, so a command's own table never lists them — but an agent told
 * "these are the valid flags" must not then be refused for using one of them.
 */
export const GLOBAL_FLAGS: readonly string[] = ["--help", "--cwd", "--format"];

/**
 * The one wording of an unknown-flag refusal, for every command.
 *
 * It names the command and lists that command's valid flags inline, so the refusal
 * corrects itself in one step: the caller's deterministic next move after "unknown
 * option" is `meta <command> --help`, and this folds that lookup into the error. It
 * used to come in three spellings (`Unknown option '--x'. To specify a positional
 * argument starting with a '-', place it at the end of the command after '--' …`,
 * `unknown flag: --x`, `unknown option: --x`), the first being Node's own parser text,
 * and none of them said which flags would have worked.
 */
export function unknownFlagMessage(command: string, flag: string, valid: readonly string[]): string {
  return `unknown flag ${flag} for \`meta ${command}\`. Valid flags: ${valid.join(", ")} ` +
    `(also accepted everywhere: ${GLOBAL_FLAGS.join(", ")})`;
}

/** The `--long` (and `-s`) spellings an option table accepts, in table order. */
export function flagNames(options: ParseArgsConfig["options"]): string[] {
  const names: string[] = [];
  for (const [long, opt] of Object.entries(options ?? {})) {
    if (long === "help") continue; // a global flag — listed once, in GLOBAL_FLAGS
    names.push(opt.short !== undefined ? `--${long}, -${opt.short}` : `--${long}`);
  }
  return names;
}

/**
 * `node:util` `parseArgs` with the unknown-flag refusal translated into
 * {@link unknownFlagMessage}. Every other parse error passes through unchanged.
 */
export function parseCommandArgs<T extends ParseArgsConfig>(
  command: string,
  config: T,
): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ERR_PARSE_ARGS_UNKNOWN_OPTION") throw err;
    const flag = /Unknown option '([^']+)'/.exec((err as Error).message)?.[1] ?? "(unrecognized)";
    throw new Error(unknownFlagMessage(command, flag, flagNames(config.options)));
  }
}
