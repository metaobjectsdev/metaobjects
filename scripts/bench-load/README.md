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

Wall-clock is noisy on a busy machine. Compare the 20x/1x growth ratio, not absolute
milliseconds, and treat the deterministic call-count tests in each port
(`top-level-index` tests) as the regression gate; this tool is for measurement, not CI.
