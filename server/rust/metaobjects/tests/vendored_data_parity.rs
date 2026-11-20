//! The crate embeds copies of repo-level files (the metamodel JSON, the shared error
//! catalogue and the shipped libraries) from `data/`, so a packaged crate builds on its
//! own. This test holds each copy byte-identical to its source. Outside the repository
//! (a packaged crate has no `spec/` beside it) there is nothing to compare, and it passes.

use std::fs;
use std::path::{Path, PathBuf};

fn files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            files(&p, out);
        } else {
            out.push(p);
        }
    }
}

/// The crate's directory, relative to the repository root.
const CRATE_DIR: &str = "server/rust/metaobjects";

fn same(copy: &Path, source: &Path) {
    let krate = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = krate.join("../../..");
    let a = fs::read(copy).unwrap();
    let b = fs::read(source)
        .unwrap_or_else(|_| panic!("{} has no source {}", copy.display(), source.display()));
    // Name the step that fixes it, as a command run from the repository root.
    let copy_rel = Path::new(CRATE_DIR).join(copy.strip_prefix(krate).unwrap());
    let source_rel = source.strip_prefix(&root).unwrap();
    assert!(
        a == b,
        "{} drifted from {}: from the repository root, run `cp {} {}`",
        copy.display(),
        source.display(),
        source_rel.display(),
        copy_rel.display()
    );
}

#[test]
fn vendored_copies_match_their_sources() {
    let krate = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = krate.join("../../..");
    if !root.join("spec/metamodel").is_dir() {
        return;
    }
    let data = krate.join("data");
    same(
        &data.join("ERROR-CODES.json"),
        &root.join("fixtures/conformance/ERROR-CODES.json"),
    );

    let mut copies = Vec::new();
    files(&data.join("metamodel"), &mut copies);
    for c in &copies {
        same(c, &root.join("spec/metamodel").join(c.file_name().unwrap()));
    }

    // Every shipped library file must be vendored, and every vendored one must match.
    let mut vendored = Vec::new();
    files(&data.join("library"), &mut vendored);
    let mut sources = Vec::new();
    files(&root.join("library"), &mut sources);
    assert_eq!(
        vendored.len(),
        sources.len(),
        "library/ and {CRATE_DIR}/data/library differ in file count: from the repository root, run `rsync -a --delete library/ {CRATE_DIR}/data/library/`"
    );
    for c in &vendored {
        same(
            c,
            &root
                .join("library")
                .join(c.strip_prefix(data.join("library")).unwrap()),
        );
    }
}
