# jsre

A tiny, std-only (zero crates.io dependencies) backtracking regex engine that
reproduces JavaScript (ECMAScript, non-unicode mode, no `i`/`m`/`s` flags)
matching semantics for a fixed list of real patterns.

## What it is not

It is not a general regex engine. It supports only the subset below; any other
syntax makes `Regex::new` return `Err` instead of risking a silent mis-match.
There is no step budget: it is plain backtracking, intended for anchored
patterns over short single-line inputs.

## Supported subset

- Literals; escapes `\s \S \d \D \w \W \b \B \t \n \r \v \f` and escaped
  punctuation (`\. \/ \- \( \) \[ \] \+ \\ \$` ...).
- `.` (anything except `\n`, `\r`, U+2028, U+2029).
- Classes `[...]` / `[^...]` with ranges and `\s \d \w` style escapes.
- Groups: capturing `(...)`, non-capturing `(?:...)`, negative lookahead `(?!...)`.
- Alternation `|`; quantifiers `* + ? {n} {n,} {n,m}`, each greedy or lazy.
- Anchors `^` and `$` (start / end of input only).
- JS details: leftmost match, JS backtracking priority, empty-iteration
  rejection, captures inside a repeated group reset per iteration, `\s` is the
  exact JS whitespace set (including NBSP, U+FEFF, U+2028/9, U+3000), `\w`/`\b`
  are ASCII-only. Not-participating groups are `None`.

Not supported (errors): backreferences, lookbehind, positive lookahead, named
groups, `\u`/`\x`/`\0`/`\c` escapes, literal `{`, flags, Unicode mode.

## API

`Regex::new`, `Regex::find_at(&[char], start) -> Option<Match>`,
`Regex::find_all` (`matchAll` / `g`-flag semantics, empty match advances by one),
`Regex::captures_str`. Offsets are `char` indices.

## How it is verified

`tests/differential.rs` runs every real pattern (the `tasks-axi` markdown
grammar and PR URL regexes, copied verbatim) over thousands of deterministic
pseudo-random inputs per pattern, evaluates the same cases with node's real
`RegExp` through `tests/oracle.mjs`, and compares match start/end and every
capture group (UTF-16 indices are converted to code-point indices). It prints
the number of cases compared and fails with the first 10 mismatches. If `node`
is not on PATH the test prints `SKIPPED` and passes. Engine unit tests live in
`src/lib.rs`.
