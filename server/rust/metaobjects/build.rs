//! Embeds the repo-root `library/` tree (YAML files and `library.json` manifests)
//! into the crate, as the other ports do, so a shipped library resolves with no
//! file on disk. When the directory is absent (the crate built outside the
//! repository) the embed is empty.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn collect(
    dir: &Path,
    rel: &str,
    yaml: &mut Vec<(String, PathBuf)>,
    manifests: &mut Vec<(String, PathBuf)>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        if path.is_dir() {
            collect(&path, &child_rel, yaml, manifests);
        } else if let Some(r) = child_rel.strip_suffix(".yaml") {
            yaml.push((r.to_string(), path));
        } else if name == "library.json" && !rel.is_empty() && !rel.contains('/') {
            manifests.push((rel.to_string(), path));
        }
    }
}

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let lib_dir = manifest_dir.join("data/library");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", lib_dir.display());
    let (mut yaml, mut manifests) = (Vec::new(), Vec::new());
    collect(&lib_dir, "", &mut yaml, &mut manifests);
    yaml.sort();
    manifests.sort();
    for (_, p) in yaml.iter().chain(manifests.iter()) {
        println!("cargo:rerun-if-changed={}", p.display());
    }
    let mut out = String::new();
    for (name, list) in [
        ("EMBEDDED_LIBRARY", &yaml),
        ("EMBEDDED_LIBRARY_MANIFESTS", &manifests),
    ] {
        let _ = writeln!(out, "pub static {name}: &[(&str, &str)] = &[");
        for (key, path) in list {
            let abs = std::fs::canonicalize(path).expect("canonicalize library file");
            let _ = writeln!(
                out,
                "    ({key:?}, include_str!({:?})),",
                abs.display().to_string()
            );
        }
        out.push_str("];\n");
    }
    let dest =
        PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("embedded_library.rs");
    let unchanged = std::fs::read_to_string(&dest).is_ok_and(|old| old == out);
    if !unchanged {
        std::fs::write(dest, out).expect("write embedded_library.rs");
    }
}
