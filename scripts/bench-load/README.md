# Warm-load benchmark

Measures how long each loader takes to load a model that is N times the size of the
persistence-conformance "fitness" model, so growth with model size is visible (a quadratic
lookup shows up as a 20x model costing far more than 20x the 1x model).

```
scripts/bench-load/run.sh [--sizes "1 5 10 20"] [--loads 7] [--ports "typescript python csharp"]
                          [--src <repo-root>] [--canonical-dir <dir>]
```

- `gen-model.py <copies> <out-dir>` writes N renamed copies of the fitness model (one package
  each), so every copy adds the same references and nothing collides.
- `ts-load.mjs`, `py_load.py`, `csharp/` are the three warm-load drivers. Each does one
  untimed warm-up load, then times `--loads` loads and prints the median and peak RSS.
- `run.sh` generates the models, builds the C# driver, runs the drivers and prints a table.
  Scratch lives under `$DEV_SCRATCH` (else the system temp dir) and is removed on exit.
- `--src` points at another checkout (for a "before" row from a pristine copy of an older
  commit). Its TypeScript `metadata` package must be built (`dist/`).
- `--canonical-dir` also writes each port's canonical serialization of the largest model, so two
  runs can be compared byte for byte (`cmp`) to show a change did not alter the loaded tree.

## Every port, stage by stage

```
python3 scripts/bench-load/stages.py [--runs 5] [--copies 20] [--ports "typescript python csharp java kotlin rust"]
                                     [--out <dir>]
python3 scripts/bench-load/stages.py --project <path> --out <dir-outside-the-repo> [--metadata-dir metaobjects]
```

`stages.py` times four stages per port on the same model: `load` (warm load and validate),
`gen-noop` (the generation command with nothing changed), `gen-full` (from clean output) and
`gen-edit` (after one entity gains a field), each the median of `--runs` runs with the peak
resident set. It writes `report.json` and `report.md` to `--out` and never gates on a number. A
stage a port cannot run prints "not available" with the reason: the Rust generation stages read
that way until `cargo meta gen` exists, and run on their own once it does (set
`MO_BENCH_RUST_META` to use a command that is not on `PATH`, `MO_BENCH_RUST_GEN_ARGS` for its
flags). Each port generates with its own CLI and one reference generator, so a generation row
tracks a port against itself over time more than against the others. Java needs the
`metaobjects-*` artifacts of the repo version in the local Maven repository; Kotlin loads
through the Java loader, so it has generation rows only.

The model is the fitness model repeated `--copies` times with every declaration renamed per copy
(`gen-model.py --unique-names`) so it can be generated as well as loaded.

`--project` measures your own project: its metadata directory is copied into scratch (the project is
never written to), the report names no path and no entity, and `--out` must be outside this repository.
A private run stays local and its report is never committed.

Wall-clock is noisy on a busy machine. Compare the 20x/1x growth ratio, not absolute
milliseconds, and treat the deterministic call-count tests in each port
(`top-level-index` tests) as the regression gate; this tool is for measurement, not CI.
