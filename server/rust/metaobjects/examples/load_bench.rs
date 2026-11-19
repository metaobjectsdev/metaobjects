//! Load-time benchmark on a 20-times model built in memory from the public
//! conformance fitness model (`fixtures/persistence-conformance/canonical/meta.fitness.json`).
//!
//! Each copy keeps every name and gets its own root package (`fitness_x00` ...
//! `fitness_x19`), so the copies never collide and every bare reference still
//! resolves inside its own copy. Nothing is written to disk.
//!
//! Run it in release mode:
//!
//! ```text
//! cargo run --release --example load_bench [-- <copies> <iterations>
//!     [json|yaml|project] [--baseline <file>] [--write-baseline <file>]]
//! cargo run --release --example load_bench -- --dir <project> [--iterations <n>] [--json]
//! ```
//!
//! `--dir` loads a real project instead of the built-in model: it resolves the project's
//! sources the way every port does (config, directory walk, file text) and times the whole
//! read plus load, one untimed warm-up first, so the figure is comparable with the other
//! ports' warm-load drivers in `scripts/bench-load/`. `--json` prints one machine-readable
//! line (`port`, `loads`, `median_ms`, `peak_rss_mib`) in the shape those drivers print.
//!
//! The mode picks what is loaded: `json` (the default) loads the model as JSON;
//! `yaml` loads the same model as sigil-free authoring YAML, so the phase table
//! shows the YAML parse and desugar as its own row; `project` times the
//! project-reading steps (the config read, the directory walk, reading the file
//! text and the library sources) and exits. Each mode is its own process, so a
//! peak-memory reading belongs to that mode alone.
//!
//! It prints one table of time per load phase and one of time per validation pass
//! (the median over the iterations), and the peak memory of the process. With
//! `--baseline` each row also shows the baseline's figure and the change; with
//! `--write-baseline` the run is saved in that file's format. A baseline is a record
//! to read: the comparison never fails the run.

use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use metaobjects::collection::resolve_collection;
use metaobjects::loader::Loader;
use metaobjects::naming::NamingRegistry;
use metaobjects::node::{NodeId, Tree};
use metaobjects::providers::default_registry;
use metaobjects::serializer::canonical_serialize;
use metaobjects::timing::{LoadTimings, ms, render_table};

const FITNESS: &str =
    include_str!("../../../../fixtures/persistence-conformance/canonical/meta.fitness.json");
const ROOT_PACKAGE: &str = "\"package\": \"fitness\"";

fn median(mut v: Vec<Duration>) -> Duration {
    v.sort();
    v[v.len() / 2]
}

/// One pass of every memoized resolving read over every node: the read path a
/// runtime caller exercises. The first pass on a frozen tree fills the caches.
fn read_pass(tree: &Tree) -> usize {
    let mut n = 0;
    for i in 0..tree.len() {
        let id = NodeId::from_index(i);
        n += tree.children(id).len() + tree.attrs(id).len();
        n += usize::from(tree.resolved_is_array(id));
    }
    n
}

/// The median of each named timing across the iterations, in first-seen order.
fn median_by_name(runs: &[Vec<(String, f64)>]) -> Vec<(String, f64)> {
    let mut names: Vec<String> = Vec::new();
    for run in runs {
        for (n, _) in run {
            if !names.contains(n) {
                names.push(n.clone());
            }
        }
    }
    names
        .into_iter()
        .map(|n| {
            let mut v: Vec<f64> = runs
                .iter()
                .map(|r| r.iter().find(|(m, _)| *m == n).map_or(0.0, |(_, t)| *t))
                .collect();
            v.sort_by(f64::total_cmp);
            let mid = v[v.len() / 2];
            (n, mid)
        })
        .collect()
}

fn rows(t: &[metaobjects::timing::Timing]) -> Vec<(String, f64)> {
    t.iter()
        .map(|x| (x.name.to_string(), ms(x.duration)))
        .collect()
}

/// The peak resident set of this process in KiB (`VmHWM`), where the OS reports it.
fn peak_rss_kib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

fn to_json_rows(rows: &[(String, f64)]) -> Value {
    Value::Object(
        rows.iter()
            .map(|(n, t)| (n.clone(), json!((t * 1000.0).round() / 1000.0)))
            .collect::<Map<_, _>>(),
    )
}

fn from_json_rows(v: &Value) -> Vec<(String, f64)> {
    v.as_object()
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_f64()?)))
                .collect()
        })
        .unwrap_or_default()
}

/// A canonical node as sigil-free authoring YAML (ADR-0006): attributes lose
/// their `@`, and the fused `type.subType` key stays. `prefix` is the text before
/// the key on its first line (`"- "` for a list item), which also sets the
/// column the body lines up under.
fn emit_node(out: &mut String, prefix: &str, node: &Value) {
    let (key, body) = node
        .as_object()
        .and_then(|m| m.iter().next())
        .expect("a node is a one-key wrapper");
    out.push_str(&format!("{prefix}{key}:\n"));
    let pad = " ".repeat(prefix.len() + 2);
    for (k, v) in body.as_object().expect("a node body is a mapping") {
        if k == "children" {
            out.push_str(&format!("{pad}children:\n"));
            for child in v.as_array().expect("children is a list") {
                emit_node(out, &format!("{pad}  - "), child);
            }
        } else {
            let k = k.strip_prefix('@').unwrap_or(k);
            // A JSON value is a YAML flow value.
            out.push_str(&format!("{pad}{k}: {v}\n"));
        }
    }
}

fn to_yaml(json: &str) -> String {
    let doc: Value = serde_json::from_str(json).expect("the model is JSON");
    let mut out = String::new();
    emit_node(&mut out, "", &doc);
    out
}

/// The project-reading steps, each timed on its own: read the config, walk the
/// metadata directory, and read every file's text. The model is written to a
/// scratch directory (`$DEV_SCRATCH`, a RAM disk) and removed afterwards.
fn project_rows(sources: &[(String, String)], iterations: usize) {
    let base = std::env::var_os("DEV_SCRATCH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join(format!("mo-load-bench-{}", std::process::id()));
    std::fs::create_dir_all(dir.join(".metaobjects")).expect("scratch dir");
    std::fs::create_dir_all(dir.join("metaobjects")).expect("scratch dir");
    std::fs::write(
        dir.join(".metaobjects/config.json"),
        r#"{ "schema_version": 1, "naming": { "columns": "snake_case" }, "libraries": ["iam", "ai"] }"#,
    )
    .expect("config");
    for (id, text) in sources {
        std::fs::write(dir.join("metaobjects").join(id), text).expect("model file");
    }
    let naming = NamingRegistry::builtin();
    let (mut resolves, mut reads) = (Vec::new(), Vec::new());
    for _ in 0..iterations {
        let t = Instant::now();
        let collection = resolve_collection(&dir, None, &naming).expect("the project resolves");
        resolves.push(t.elapsed());
        let t = Instant::now();
        let (pairs, errors) = collection.read_sources();
        reads.push(t.elapsed());
        assert!(errors.is_empty(), "{errors:?}");
        std::hint::black_box(pairs);
    }
    let _ = std::fs::remove_dir_all(&dir);
    println!(
        "project: config read + directory walk ({} files), median of {iterations}: {:?}",
        sources.len(),
        median(resolves)
    );
    println!(
        "project: read every file's text plus the library sources, median of {iterations}: {:?}",
        median(reads)
    );
    if let Some(kib) = peak_rss_kib() {
        println!("peak memory: {kib} KiB");
    }
}

/// Warm-load a project directory: the project read (config, walk, file text) plus the
/// load, as one figure per iteration, after one untimed warm-up.
fn dir_bench(dir: &std::path::Path, iterations: usize, json_line: bool) {
    let naming = NamingRegistry::builtin();
    let registry = default_registry().expect("the built-in providers compose");
    let loader = Loader::new(&registry);
    let load_once = || {
        let collection = resolve_collection(dir, None, &naming).expect("the project resolves");
        let (pairs, errors) = collection.read_sources();
        assert!(errors.is_empty(), "read errors: {:?}", errors.first());
        let result = loader.load_sources(&pairs);
        assert!(
            result.errors.is_empty(),
            "load errors: {:?}",
            result.errors.first()
        );
        result.tree.len()
    };
    let nodes = load_once();
    let mut times = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let t = Instant::now();
        std::hint::black_box(load_once());
        times.push(t.elapsed());
    }
    let median_ms = (ms(median(times)) * 10.0).round() / 10.0;
    let rss_mib = peak_rss_kib().map(|k| (k as f64 / 1024.0).round());
    if json_line {
        println!(
            "{}",
            json!({ "port": "rust", "loads": iterations, "median_ms": median_ms, "peak_rss_mib": rss_mib, "nodes": nodes })
        );
    } else {
        println!(
            "{nodes} nodes, warm load median of {iterations}: {median_ms} ms, peak {rss_mib:?} MiB"
        );
    }
}

fn main() {
    let mut baseline_path = None;
    let mut write_path = None;
    let mut dir = None;
    let mut dir_iterations = 7;
    let mut json_line = false;
    let mut positional = Vec::new();
    let mut raw = std::env::args().skip(1);
    while let Some(a) = raw.next() {
        match a.as_str() {
            "--dir" => dir = Some(raw.next().expect("--dir takes a project directory")),
            "--iterations" => {
                dir_iterations = raw
                    .next()
                    .and_then(|n| n.parse().ok())
                    .expect("--iterations takes a number");
            }
            "--json" => json_line = true,
            "--baseline" => baseline_path = Some(raw.next().expect("--baseline takes a file")),
            "--write-baseline" => {
                write_path = Some(raw.next().expect("--write-baseline takes a file"));
            }
            _ => positional.push(a),
        }
    }
    if let Some(dir) = dir {
        dir_bench(std::path::Path::new(&dir), dir_iterations, json_line);
        return;
    }
    let mut args = positional.into_iter();
    let copies: usize = args
        .next()
        .map_or(20, |a| a.parse().expect("copies is a number"));
    let iterations: usize = args
        .next()
        .map_or(15, |a| a.parse().expect("iterations is a number"));
    let mode = args.next().unwrap_or_else(|| "json".to_string());
    assert!(
        ["json", "yaml", "project"].contains(&mode.as_str()),
        "mode is json, yaml or project, not {mode}"
    );
    assert!(
        FITNESS.contains(ROOT_PACKAGE),
        "the fitness model declares its root package"
    );
    let sources: Vec<(String, String)> = (0..copies)
        .map(|i| {
            let text = FITNESS.replacen(
                ROOT_PACKAGE,
                &format!("\"package\": \"fitness_x{i:02}\""),
                1,
            );
            (format!("meta.fitness_x{i:02}.json"), text)
        })
        .collect();
    if mode == "project" {
        project_rows(&sources, iterations);
        return;
    }
    let sources: Vec<(String, String)> = if mode == "yaml" {
        sources
            .iter()
            .map(|(id, text)| (id.replace(".json", ".yaml"), to_yaml(text)))
            .collect()
    } else {
        sources
    };
    let bytes: usize = sources.iter().map(|(_, t)| t.len()).sum();

    let t = Instant::now();
    let registry = default_registry().expect("the built-in providers compose");
    let compose = t.elapsed();

    let loader = Loader::new(&registry);
    let mut loads = Vec::with_capacity(iterations);
    let mut serializes = Vec::with_capacity(iterations);
    let mut cold_reads = Vec::with_capacity(iterations);
    let mut warm_reads = Vec::with_capacity(iterations);
    let mut phase_runs = Vec::with_capacity(iterations);
    let mut pass_runs = Vec::with_capacity(iterations);
    let mut nodes = 0;
    for _ in 0..iterations {
        let t = Instant::now();
        let result = loader.load_sources(&sources);
        loads.push(t.elapsed());
        assert!(
            result.errors.is_empty(),
            "the scaled model loads clean: {:?}",
            result.errors.first()
        );
        nodes = result.tree.len();
        let timings: &LoadTimings = &result.timings;
        phase_runs.push(rows(&timings.phases));
        pass_runs.push(rows(&timings.passes));
        let t = Instant::now();
        std::hint::black_box(read_pass(&result.tree));
        cold_reads.push(t.elapsed());
        let t = Instant::now();
        std::hint::black_box(read_pass(&result.tree));
        warm_reads.push(t.elapsed());
        let t = Instant::now();
        let out = canonical_serialize(&result.tree, result.root);
        serializes.push(t.elapsed());
        std::hint::black_box(out);
    }
    println!(
        "model: {copies} copies of the fitness model, {} KiB of {}, {nodes} nodes",
        bytes / 1024,
        mode.to_uppercase()
    );
    println!("registry compose: {compose:?}");
    println!(
        "load (parse, merge, extends, references), median of {iterations}: {:?}",
        median(loads)
    );
    let phases = median_by_name(&phase_runs);
    let passes = median_by_name(&pass_runs);
    let peak = peak_rss_kib();
    let baseline: Option<Value> = baseline_path.as_ref().map(|p| {
        serde_json::from_str(&std::fs::read_to_string(p).expect("baseline file is readable"))
            .expect("baseline file is JSON")
    });
    println!();
    print!(
        "{}",
        render_table(
            "load phase",
            &phases,
            baseline
                .as_ref()
                .map(|b| from_json_rows(&b["phases"]))
                .as_deref()
        )
    );
    println!();
    if passes.is_empty() {
        println!("validation passes: none implemented yet");
    } else {
        print!(
            "{}",
            render_table(
                "validation pass",
                &passes,
                baseline
                    .as_ref()
                    .map(|b| from_json_rows(&b["passes"]))
                    .as_deref()
            )
        );
    }
    println!();
    match (
        peak,
        baseline.as_ref().and_then(|b| b["peakRssKiB"].as_u64()),
    ) {
        (Some(now), Some(was)) => println!(
            "peak memory: {} KiB (baseline {was} KiB, {:+.1}%)",
            now,
            (now as f64 - was as f64) / was as f64 * 100.0
        ),
        (Some(now), None) => println!("peak memory: {now} KiB"),
        (None, _) => println!("peak memory: not reported on this OS"),
    }
    if let Some(path) = write_path {
        let doc = json!({
            "note": "Record only: a reference to read, never a threshold. Regenerate with load_bench --write-baseline.",
            "model": format!("{copies} copies of the fitness model"),
            "nodes": nodes,
            "iterations": iterations,
            "phases": to_json_rows(&phases),
            "passes": to_json_rows(&passes),
            "peakRssKiB": peak,
        });
        std::fs::write(
            &path,
            format!("{}\n", serde_json::to_string_pretty(&doc).unwrap()),
        )
        .expect("baseline file is writable");
        println!("baseline written to {path}");
    }
    println!();
    println!(
        "resolved reads of every node (children, attrs, is_array), first pass fills the cache, median of {iterations}: {:?}",
        median(cold_reads)
    );
    println!(
        "resolved reads of every node, from the cache, median of {iterations}: {:?}",
        median(warm_reads)
    );
    println!(
        "canonical serialize, median of {iterations}: {:?}",
        median(serializes)
    );
}
