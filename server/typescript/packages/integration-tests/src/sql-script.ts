// sql-script.ts — split a committed SQL script (the schema artifacts, a scenario's seed) into
// statements for a driver that runs one statement per call.
//
// A `;` ends a statement only at the end of a line, so one inside a string literal's data (a
// title, a JSON payload) does not break it. `--` comment lines are dropped first.

export function splitStatements(script: string): string[] {
  return script
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(/;[ \t]*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}
