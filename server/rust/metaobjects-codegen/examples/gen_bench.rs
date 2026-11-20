//! Code-generation time per stage on a 20-times project written to disk, built from the
//! public conformance fitness model
//! (`fixtures/persistence-conformance/canonical/meta.fitness.json`).
//!
//! Each copy keeps every name and gets its own root package (`fitness_x00` ... `fitness_x19`),
//! so each becomes its own model, client and command crate: every shipped generator runs. The project lives under `$DEV_SCRATCH` (a RAM disk when set)
//! and is removed when the run ends.
//!
//! ```text
//! cargo run --release --example gen_bench [-- <copies> <iterations>
//!     [--baseline <file>] [--write-baseline <file>]]
//! ```
//!
//! Four scenarios, each the median over the iterations, each as a table of time per stage
//! (load, plan, skip, render, write):
//!
//! - `first run`: no outputs and no state on disk; every file is created.
//! - `no change`: the run after it; the skip key matches, so nothing renders or writes.
//! - `one file changed`: one object in one copy gained a description; one file is rewritten, and the
//!   manifest is saved once.
//! - `forced, nothing changed`: `--force`; every file is rendered and compared and none is
//!   written, which is what the write path costs when bytes are identical.
//!
//! With `--baseline` each row also shows the baseline's figure and the change; with
//! `--write-baseline` the run is saved in that file's format. A baseline is a record to read:
//! the comparison never fails the run.

use std::path::{Path, PathBuf};
use std::time::Instant;

use metaobjects::timing::{ms, render_table};
use metaobjects_codegen::engine::{STAGE_LOAD, STAGE_PLAN, STAGE_RENDER, STAGE_SKIP, STAGE_WRITE};
use metaobjects_codegen::{Outcome, RunOptions, RunReport, run, shipped_generators};
use serde_json::{Map, Value, json};

const FITNESS: &str =
    include_str!("../../../../fixtures/persistence-conformance/canonical/meta.fitness.json");
const ROOT_PACKAGE: &str = "\"package\": \"fitness\"";
/// An object that exists in every copy; the change scenario gives it a description.
const CHANGE_AT: &str = "\"name\": \"AllTypes\"";

const STAGES: [&str; 5] = [
    STAGE_LOAD,
    STAGE_PLAN,
    STAGE_SKIP,
    STAGE_RENDER,
    STAGE_WRITE,
];

fn scratch_base() -> PathBuf {
    std::env::var_os("DEV_SCRATCH")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().expect("a file has a parent")).expect("mkdir");
    std::fs::write(path, text).expect("write");
}

fn copy_text(i: usize) -> String {
    FITNESS.replacen(
        ROOT_PACKAGE,
        &format!("\"package\": \"fitness_x{i:02}\""),
        1,
    )
}

fn gen_run(project: &Path, force: bool) -> RunReport {
    let mut opts = RunOptions::new(project);
    opts.force = force;
    run(&opts, &shipped_generators()).unwrap_or_else(|e| panic!("gen failed: {e}"))
}

/// Time per stage in milliseconds, every stage present (zero when the run skipped it), plus
/// the run's total.
fn stage_rows(r: &RunReport) -> Vec<(String, f64)> {
    let mut rows: Vec<(String, f64)> = STAGES
        .iter()
        .map(|s| (s.to_string(), ms(r.timings.phase_time(s))))
        .collect();
    rows.push(("total".to_string(), ms(r.timings.total())));
    rows
}

fn median_rows(runs: &[Vec<(String, f64)>]) -> Vec<(String, f64)> {
    let names: Vec<String> = runs[0].iter().map(|(n, _)| n.clone()).collect();
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
        .map_or(9, |a| a.parse().expect("iterations is a number"));
    assert!(FITNESS.contains(ROOT_PACKAGE) && FITNESS.contains(CHANGE_AT));

    let project = scratch_base().join(format!("mo-gen-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&project);
    write(
        &project.join(".metaobjects/config.json"),
        r#"{ "schema_version": 1 }"#,
    );
    let model_file = |i: usize| project.join(format!("metaobjects/meta.fitness_x{i:02}.json"));
    for i in 0..copies {
        write(&model_file(i), &copy_text(i));
    }
    let bytes: usize = (0..copies).map(|i| copy_text(i).len()).sum();

    let mut firsts = Vec::new();
    let mut skips = Vec::new();
    let mut changes = Vec::new();
    let mut forced = Vec::new();
    let mut files = 0;
    let started = Instant::now();
    for n in 0..iterations {
        // A cold start: no outputs, no manifest, no stored key.
        let _ = std::fs::remove_dir_all(project.join("generated"));
        let _ = std::fs::remove_dir_all(project.join(".metaobjects/.gen-state"));
        write(&model_file(0), &copy_text(0));

        let r = gen_run(&project, false);
        assert_eq!(r.outcome, Outcome::Generated);
        files = r.files.created;
        firsts.push(stage_rows(&r));

        let r = gen_run(&project, false);
        assert_eq!(r.outcome, Outcome::Skipped, "an unchanged project skips");
        skips.push(stage_rows(&r));

        // A new description on AllTypes in copy 0; different each iteration.
        let edited = copy_text(0).replacen(
            CHANGE_AT,
            &format!("\"name\": \"AllTypes\", \"@description\": \"edit {n}\""),
            1,
        );
        write(&model_file(0), &edited);
        let r = gen_run(&project, false);
        assert_eq!(r.outcome, Outcome::Generated);
        assert_eq!(
            r.files.overwritten, 1,
            "one object changed, one file rewrites"
        );
        changes.push(stage_rows(&r));

        let r = gen_run(&project, true);
        assert_eq!(r.outcome, Outcome::Generated);
        assert_eq!(r.files.created + r.files.overwritten, 0);
        forced.push(stage_rows(&r));
    }
    let elapsed = started.elapsed();
    let _ = std::fs::remove_dir_all(&project);

    println!(
        "project: {copies} copies of the fitness model, {} KiB of JSON, {files} generated files in {copies} crates",
        bytes / 1024
    );
    println!("median of {iterations} iterations; whole benchmark {elapsed:.1?}");

    let scenarios = [
        ("first run", median_rows(&firsts)),
        ("no change", median_rows(&skips)),
        ("one file changed", median_rows(&changes)),
        ("forced, nothing changed", median_rows(&forced)),
    ];
    let baseline: Option<Value> = baseline_path.as_ref().map(|p| {
        serde_json::from_str(&std::fs::read_to_string(p).expect("baseline file is readable"))
            .expect("baseline file is JSON")
    });
    for (name, rows) in &scenarios {
        println!();
        print!(
            "{}",
            render_table(
                name,
                rows,
                baseline
                    .as_ref()
                    .map(|b| from_json_rows(&b[name]))
                    .as_deref()
            )
        );
    }
    if let Some(p) = write_path {
        let doc: Map<String, Value> = scenarios
            .iter()
            .map(|(n, rows)| (n.to_string(), to_json_rows(rows)))
            .collect();
        std::fs::write(
            &p,
            serde_json::to_string_pretty(&Value::Object(doc)).unwrap() + "\n",
        )
        .expect("write baseline");
        println!("\nbaseline written to {p}");
    }
}
