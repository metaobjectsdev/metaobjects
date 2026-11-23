//! The scale gate: what the generators write for a large model, and what it costs to build.
//!
//! The model is the public fitness model twenty times over, each copy under its own root
//! package (the shape `gen_bench` times), so each copy is its own model crate, client crate
//! and command crate. Three things are held:
//!
//! - **Growth is linear.** Twenty copies write twenty times the per-package files and no more
//!   than twenty times the bytes (plus the package name's own length). A generator that
//!   started writing something per pair of entities would fail here long before a build
//!   got slow.
//! - **Size is budgeted.** The output for one copy has a byte budget and a longest-file
//!   budget. Generated code is read in review and compiled on every build, so growth in it is
//!   a cost someone must decide to pay: raise the number in the change that needs it.
//! - **It builds.** `cargo check` accepts every crate, every file is in rustfmt's
//!   form, and the time each step took is printed. The times have a ceiling far above a
//!   normal run, there to catch a step that stopped scaling, not to measure the machine.

mod common;

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant};

use common::{
    FITNESS, Scratch, assert_builds, assert_formatted, assert_pinned, generate_all,
    generated_workspace,
};

const COPIES: usize = 20;
const ROOT_PACKAGE: &str = "\"package\": \"fitness\"";
/// The crates every run writes once, however large the model.
const SHARED: &[&str] = &[
    "meta_support",
    "meta_client",
    "meta_cli",
    "meta_store",
    "meta_service",
];

/// The generated output for ONE copy of the fitness model, shared crates left out. Its 25
/// reports and 3 projections are each a model type and a store module (about 2 KB apiece).
/// The service crate (ADR-0067 layer 4) adds about 185 KB: each writable entity's file holds
/// its create, update and delete twice (the write and its `_in` twin) with their checks.
const BUDGET_BYTES: usize = 600_000;
/// The longest generated file for the fitness model, in lines.
const BUDGET_LONGEST_FILE: usize = 500;
const CEILING_GEN: Duration = Duration::from_secs(120);
const CEILING_CHECK: Duration = Duration::from_secs(1_200);

fn copy_text(i: usize) -> String {
    assert!(
        FITNESS.contains(ROOT_PACKAGE),
        "the fitness model no longer declares its package this way"
    );
    FITNESS.replacen(
        ROOT_PACKAGE,
        &format!("\"package\": \"fitness_x{i:02}\""),
        1,
    )
}

/// What was generated for a project: every file's text, by path under `generated/`.
fn output(project: &Scratch) -> BTreeMap<String, String> {
    fn walk(dir: &Path, base: &Path, out: &mut BTreeMap<String, String>) {
        for entry in std::fs::read_dir(dir).unwrap().map(Result::unwrap) {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, base, out);
            } else {
                let rel = path
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(rel, std::fs::read_to_string(&path).unwrap());
            }
        }
    }
    let base = project.path().join("generated");
    let mut out = BTreeMap::new();
    walk(&base, &base, &mut out);
    out
}

fn is_shared(path: &str) -> bool {
    SHARED
        .iter()
        .any(|root| path.split('/').next() == Some(root))
}

/// The files of the per-package crates.
fn per_package(output: &BTreeMap<String, String>) -> impl Iterator<Item = (&String, &String)> {
    output.iter().filter(|(path, _)| !is_shared(path))
}

fn bytes<'a>(files: impl Iterator<Item = (&'a String, &'a String)>) -> usize {
    files.map(|(_, text)| text.len()).sum()
}

#[test]
fn twenty_copies_of_the_fitness_model_grow_linearly_stay_in_budget_and_build() {
    let one = Scratch::project("scale-one", &common::FITNESS_PROJECT);
    generate_all(&one, &[]);
    let one_out = output(&one);
    let (one_files, one_bytes) = (per_package(&one_out).count(), bytes(per_package(&one_out)));

    let texts: Vec<(String, String)> = (0..COPIES)
        .map(|i| {
            (
                format!("metaobjects/meta.fitness_x{i:02}.json"),
                copy_text(i),
            )
        })
        .collect();
    // Every copy's prompt names the same body.
    let files: Vec<(&str, &str)> = texts
        .iter()
        .map(|(p, t)| (p.as_str(), t.as_str()))
        .chain([common::FITNESS_PROJECT[1]])
        .collect();
    let many = Scratch::project("scale-many", &files);
    let started = Instant::now();
    generate_all(&many, &[]);
    let gen_time = started.elapsed();
    let many_out = output(&many);
    let (many_files, many_bytes) = (
        per_package(&many_out).count(),
        bytes(per_package(&many_out)),
    );

    // Size: one copy is within its budget.
    let (longest_path, longest) = per_package(&one_out)
        .map(|(path, text)| (path, text.lines().count()))
        .max_by_key(|(_, lines)| *lines)
        .unwrap();
    println!(
        "one copy: {one_files} files, {one_bytes} bytes (budget {BUDGET_BYTES}); longest file {longest} lines (budget {BUDGET_LONGEST_FILE}): {longest_path}"
    );
    assert!(
        one_bytes <= BUDGET_BYTES,
        "the fitness model's generated output grew to {one_bytes} bytes, over its budget of {BUDGET_BYTES}"
    );
    assert!(
        longest <= BUDGET_LONGEST_FILE,
        "{longest_path} is {longest} lines, over the budget of {BUDGET_LONGEST_FILE}"
    );

    // Growth: twenty copies are twenty times one copy. The only bytes a copy adds are its
    // longer package name wherever the output spells it (`fitness_x00` for `fitness`), and
    // the few lines that name pushes over the width; one part in a hundred covers those.
    assert_eq!(
        many_files,
        COPIES * one_files,
        "files per package do not depend on the model's size"
    );
    let spelled: usize = per_package(&one_out)
        .map(|(_, text)| text.matches("fitness").count())
        .sum();
    let linear = COPIES * (one_bytes + spelled * "_x00".len());
    assert!(
        many_bytes <= linear + linear / 100,
        "twenty copies wrote {many_bytes} bytes; twenty times one copy is {linear}"
    );
    let shared = |out: &BTreeMap<String, String>| -> Vec<(String, String)> {
        out.iter()
            .filter(|(p, _)| is_shared(p))
            .map(|(p, t)| (p.clone(), t.clone()))
            .collect()
    };
    assert!(
        shared(&one_out) == shared(&many_out),
        "the shared crates are the same for any model"
    );

    // Build: the real toolchain accepts all of it.
    let ws = generated_workspace("scale-ws", &many, None);
    assert_formatted(&ws);
    let started = Instant::now();
    assert_builds(&ws, "twenty copies of the fitness model");
    let check_time = started.elapsed();
    assert_pinned(&ws);
    println!(
        "{COPIES} copies: {many_files} files, {many_bytes} bytes; gen {:.1}s, cargo check {:.1}s",
        gen_time.as_secs_f64(),
        check_time.as_secs_f64()
    );
    assert!(
        gen_time <= CEILING_GEN,
        "gen took {gen_time:?}, over the ceiling of {CEILING_GEN:?}"
    );
    assert!(
        check_time <= CEILING_CHECK,
        "cargo check took {check_time:?}, over the ceiling of {CEILING_CHECK:?}"
    );
}
