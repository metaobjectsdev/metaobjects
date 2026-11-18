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
//!     [--baseline <file>] [--write-baseline <file>]]
//! ```
//!
//! It prints one table of time per load phase and one of time per validation pass
//! (the median over the iterations), and the peak memory of the process. With
//! `--baseline` each row also shows the baseline's figure and the change; with
//! `--write-baseline` the run is saved in that file's format. A baseline is a record
//! to read: the comparison never fails the run.

use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use metaobjects::loader::Loader;
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

fn main() {
    let mut baseline_path = None;
    let mut write_path = None;
    let mut positional = Vec::new();
    let mut raw = std::env::args().skip(1);
    while let Some(a) = raw.next() {
        match a.as_str() {
            "--baseline" => baseline_path = Some(raw.next().expect("--baseline takes a file")),
            "--write-baseline" => {
                write_path = Some(raw.next().expect("--write-baseline takes a file"));
            }
            _ => positional.push(a),
        }
    }
    let mut args = positional.into_iter();
    let copies: usize = args
        .next()
        .map_or(20, |a| a.parse().expect("copies is a number"));
    let iterations: usize = args
        .next()
        .map_or(15, |a| a.parse().expect("iterations is a number"));
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
        "model: {copies} copies of the fitness model, {} KiB of JSON, {nodes} nodes",
        bytes / 1024
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
