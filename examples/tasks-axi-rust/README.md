# tasks-axi-rust: the read path of tasks-axi, in Rust, generated from a MetaObjects model

`tasks-axi` is an agent-facing task tracker (a markdown backlog behind a TOON-printing CLI). This example
reimplements its **read path** (`show`, `list`, `ready`) as a small Rust binary, `tasks-axi-rs`, and
produces the Rust source for its **rows, enums, error codes, argument parser, help text and dispatcher**
from a MetaObjects model. The real tasks-axi 0.2.6 is the oracle: for every implemented read command and
flag the two tools print the same bytes and exit with the same code.

It is a prototype and an experiment, not a product. It changes nothing in MetaObjects: no core change, no
new registered vocabulary, no version bump, and `server/rust` is untouched. Everything here lives under
`examples/tasks-axi-rust/`.

Writes are not implemented. Every command that would write is **refused**, loudly (see
[What it refuses](#what-it-refuses)).

## What comes from the model, and what is hand-written

```
metaobjects/meta.tasks.yaml   rows, enums, error codes        ─┐
metaobjects/meta.cli.yaml     the command surface (one bag)   ─┤  meta gen
codegen/generators/rust-cli.ts  the owned generator           ─┘     │
                                                                     ▼
                                          crates/tasks-axi-gen/   (generated, committed)
                                                  ▲
crates/tasks-axi-rs/   hand-written: the backlog grammar, the derived state, the output ─┘ implements `Handlers`
crates/toon/           hand-written: a std-only TOON encoder
crates/jsre/           hand-written: a std-only JavaScript regex engine
```

**Generator-owned** (`crates/tasks-axi-gen/`; never edit it, `meta verify --codegen` fails if you do):

| File | What it holds |
|---|---|
| `enums.rs` | `TaskState`, `HoldKind`, `DepType`, `LinkKind`, `ListState`, with their wire strings |
| `model.rs` | `Hold`, `Dep`, `Link`, `Task` |
| `rows.rs` | `TaskRow` (18 columns), `Column`, the cell accessor, `TASK_LIST_ROW_EXTRA_COLUMNS` |
| `errors.rs` | `ErrorCode`, its exit codes, `AxiError` |
| `cli.rs` | the help and usage text, hint tables, the flag parser and its validation, in the real tool's order |
| `dispatch.rs` | `Handlers` (the trait a tool implements), `Outcome`, `run()`, the refusal of unimplemented commands |

`cli.rs` also embeds a **fixed, model-independent chunk** of flag-handling code (`js_trim`, `take_flag`,
`parse_optional_uint`, ...). It is written into the generator's source as text, not derived from the model;
a Rust-native generator would ship it as a runtime crate instead.

**Hand-written** (`crates/tasks-axi-rs/`): the markdown grammar and its regexes, link and dependency
derivation, what "blocked", "held" and "ready" mean, the config and backlog-file discovery, the hint-suffix
logic, truncation and the TOON views. The `Handlers` trait is the seam: the generator decides what the
command line means, the hand-written crate decides what the commands do.

`crates/toon` is a standalone TOON v4.1 encoder (179 of 179 official encoder fixtures pass). It carries a
`Dialect::ToonJs2` option, because the `@toon-format/toon` library that tasks-axi prints with quotes
strings differently from the spec in three places (`#`, a leading `+`, and which padding counts).
`crates/jsre` is a std-only JavaScript regex engine, differentially tested against node's, because the
backlog grammar is defined by JS regexes and no regex crate matches them exactly (and `regex` would be a
dependency this tool does not otherwise need).

The workspace has no crates.io dependencies at all (the binary depends on the three path crates above and
std). The release binary is about 0.5 MB.

## The generator

`codegen/` is an owned generator in the sense of ADR-0034: a plain TypeScript `Generator` you copy and
change. It is split in three layers so the middle one is the contract:

1. **`read-model.ts`**: reads the loaded model (resolving accessors only, per ADR-0039) and the `cli`
   bag, and validates them, so a typo in the model fails `meta gen` instead of shipping.
2. **`ir.ts`**: a plain-data intermediate representation: enums, structs, rows, error codes, commands,
   flags, hints. No MetaObjects types, no Rust text.
3. **`emit/*.ts`**: turns the IR into Rust text, then `rustfmt` (read from stdin) formats it. One emitter
   per generated file.

The committed files under `crates/tasks-axi-gen/` are the **golden outputs**: the specification a
Rust-native generator would have to reproduce, byte for byte after `rustfmt`. The captain's goal is for
a Rust codegen to make the Rust project eventually; layers 1 and 2 are what it would port, and the goldens
are its test.

Regenerate with:

```sh
cd server/typescript && bun run packages/cli/bin/meta.ts gen --cwd ../../examples/tasks-axi-rust
```

`rustfmt` output can vary a little between releases and no toolchain is pinned, so a toolchain bump may
move the goldens. If it does, regenerate and commit; nothing semantic changes.

## What the `cli` bag had to carry (evidence for a `binding.cli`)

The command surface has no registered vocabulary, so it lives in one `attr.properties` bag
(`metaobjects/meta.cli.yaml`), which the strict-attr rule exempts. That is deliberate: this example is the
evidence for or against promoting it. What the bag needed, in order of how clearly it generalises:

- **Per command**: name, aliases, help text, positionals (names, min, max, a type), ordered flags,
  declared outputs (a label and a row shape), and hints with a condition and an optional "filters this
  hint survives" list.
- **Per flag**: a name and one of six types: `bool`, `line` (a non-empty single-line string), `uint`,
  `enum` (naming a model enum), `columns` (a comma list validated against a row's columns), and positional
  `taskId`. **Order matters**: the real tool reports the first invalid flag in declared order, so the
  order is part of the contract, not a detail.
- **Global**: flags that may appear anywhere and are consumed before the command's own, an optional
  "noun" word (`tasks-axi task show x`), a top-level help text, a refused-command list and a refusal
  message template.
- **Cross-references into the model**: an `enum` flag names a model enum; a `columns` flag names a row
  type and a base row type; an output names a row type; `extra` lists must be real columns. Four checks of
  this kind live in the generator, and they are exactly the checks a registered `binding.cli` would get
  from the loader for free.

What it did **not** need and a real `binding.cli` should still decide: sub-commands deeper than one level,
repeated flags, short flags (tasks-axi has none besides `-v`/`-V`), flag defaults (they are all absent),
environment variables and config files as inputs (those stayed hand-written in `config.rs`), and the
exit-code policy beyond "validation errors exit 2, everything else 1" (that is model data on
`ErrorCode`).

## Differences from tasks-axi, on purpose

- **Top-level `--help`** prints this tool's own text (it lists what is implemented), not tasks-axi's.
  Per-command help (`list --help` and so on) is byte-identical.
- **No dashboard.** `tasks-axi-rs` with no command is refused; tasks-axi would print its dashboard.
- **Refused commands print a refusal even with `--help`**: `add --help` says it is not implemented here,
  rather than showing help for a command that cannot run.
- **A backlog containing a `public-followup` task is refused** by `list`, `ready` and `show` (code
  `UNSUPPORTED`). Reproducing that feature's payload rendering is out of scope, and printing a list that
  silently omits or mangles those tasks would be worse than saying so.
- **Only the markdown backend.** `--backend` / `TASKS_AXI_BACKEND` / the `backend` config key accept
  `markdown` and refuse any other value.
- **Node's I/O error text** is reproduced for the two cases a backlog hits in practice (a directory where
  a file should be, a permission error); other I/O errors print Rust's message.
- Unset `HOME` is treated as "no home config".

Everything else, including error text, exit codes (2 for a validation error, 1 for the rest), output on
stdout only, the hint suffix rules, UTF-16 truncation of titles and bodies, and local-date hold expiry,
matches. `harness/` is how that is checked.

## What it refuses

A refused command prints a TOON error on stdout and exits **1**:

```
error: "`add` is not implemented by tasks-axi-rs, which ships the read path only (show, list, ready)"
code: UNSUPPORTED
help[1]: Run the same command with the Node tasks-axi
```

The refused list is `add, create, start, done, close, reopen, update, edit, rm, delete, block, unblock,
hold, unhold, public-followup, mv, prune, render, setup`. An unknown command is not a refusal: it is the
same `VALIDATION_ERROR` (exit 2) that tasks-axi prints. `harness/differential.ts` asserts every refusal.

## The gates

```sh
scripts/gates.sh            # all five
scripts/gates.sh --no-node  # cargo only: compile, lint, tests (the golden outputs stand in for node)
```

| Gate | Command | Fails when |
|---|---|---|
| drift | `meta verify --codegen` | the committed generated crate differs from a fresh regen, or someone edited it (`handEdits: fail` is set in `.metaobjects/config.json`) |
| compile | `cargo check -p tasks-axi-gen --all-targets` and `rustfmt --check` on the generated files | the emitted Rust does not type-check or is not formatted |
| lint | `cargo clippy --workspace --all-targets -D warnings`, `cargo fmt --check` | any warning |
| tests | `cargo test --workspace` | a TOON conformance fixture, a regex differential, a unit test or a **golden output** differs |
| behaviour | `bun harness/differential.ts` | the real tasks-axi and `tasks-axi-rs` disagree on stdout, exit code or stderr for any case |

**Golden outputs** (`crates/tasks-axi-rs/tests/golden/`) are recorded from the real tasks-axi 0.2.6 by
`bun harness/golden.ts` (148 cases) and replayed by `cargo test`, so the Rust side stays checkable without
node. They are inputs and outputs only; the tool that produced them is not needed to run them.

**The differential harness** runs both binaries side by side over seeded synthetic backlogs
(`harness/synthetic-backlog.ts`: awkward Unicode, lone surrogates, CRLF, quoting edge cases, duplicate ids,
blocked-by chains, expiring holds) and a matrix of commands and flags, plus about 110 fixed cases for
argument errors, config precedence (`--file`, environment, `.tasks.toml`, the home config), unreadable
files and the refusals. Each run is in a throwaway directory under `$DEV_SCRATCH`, with `TZ=UTC` and a
synthetic `HOME`. Typical: `bun harness/differential.ts --seeds 40` (~1,500 comparisons, under 20 s).
Nothing in it reads a real backlog.

## Benchmark

`python3 bench/bench.py` interleaves node and rust runs (30 timed runs after one warm-up, median and p95
wall time, median CPU time, median peak RSS) and refuses to time a scenario whose outputs differ.
Representative run, release build, 200-task backlog, on a heavily loaded workstation (load average ~26, so
read the **ratios and the CPU column**, not the absolute milliseconds):

| command | tool | median ms | p95 ms | CPU ms | peak RSS MiB |
|---|---|---:|---:|---:|---:|
| list | node | 47.2 | 53.8 | 55.5 | 62.5 |
| list | rust | 3.9 | 4.7 | 3.7 | 8.8 |
| ready | node | 48.2 | 53.6 | 56.2 | 62.0 |
| ready | rust | 3.6 | 4.2 | 3.4 | 8.7 |
| show | node | 45.5 | 52.2 | 53.2 | 61.9 |
| show | rust | 3.2 | 4.1 | 3.0 | 9.0 |

Most of node's time is start-up (a 5-task backlog still takes ~40 ms there, ~0.8 ms in Rust).

## Layout

```
metaobjects/            the model: meta.tasks.yaml (data), meta.cli.yaml (command surface)
codegen/                the generator: generators/rust-cli.ts, rust/{read-model,ir,names,format}.ts, rust/emit/*.ts
metaobjects.config.ts   wires rustCli() and the output directory
crates/tasks-axi-gen/   GENERATED, committed (the golden outputs)
crates/tasks-axi-rs/    the binary: main.rs, app.rs (Handlers), grammar, derive, suggest, config, view, tests/golden.rs
crates/toon/            TOON encoder + the official encoder fixtures (see its PROVENANCE.md)
crates/jsre/            JavaScript regex engine + a differential test (needs node)
harness/                differential harness, synthetic backlogs, golden recorder
bench/bench.py          the benchmark
scripts/gates.sh        every gate
```
