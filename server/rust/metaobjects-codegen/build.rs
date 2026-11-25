//! Hashes the sources of the engine and of the loader it is built on, and hands the digest
//! to the crate as `METAOBJECTS_ENGINE_SOURCE_HASH`.
//!
//! The skip key (ADR-0064 section 3) names a generator by the hash of its built code, not
//! only by a release number, so a locally built engine with different content never reuses
//! a key a different build stored. For Rust the built code is a function of these sources.

#[path = "src/sha256.rs"]
#[allow(dead_code)]
mod sha256;

use std::path::{Path, PathBuf};

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = read.filter_map(Result::ok).map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            collect(&p, out);
        } else if p.extension().is_some_and(|e| e == "rs" || e == "toml") {
            out.push(p);
        }
    }
}

fn main() {
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let roots = [
        manifest.join("src"),
        manifest.join("Cargo.toml"),
        manifest.join("../metaobjects/src"),
        manifest.join("../metaobjects/Cargo.toml"),
    ];
    let mut hasher = sha256::Sha256::new();
    for root in &roots {
        println!("cargo:rerun-if-changed={}", root.display());
        let mut files = Vec::new();
        if root.is_dir() {
            collect(root, &mut files);
        } else if root.is_file() {
            files.push(root.clone());
        }
        for f in files {
            let rel = f.strip_prefix(&manifest).unwrap_or(&f);
            hasher.update(rel.to_string_lossy().replace('\\', "/").as_bytes());
            hasher.update(&[0]);
            hasher.update(&std::fs::read(&f).unwrap_or_default());
            hasher.update(&[0]);
        }
    }
    println!(
        "cargo:rustc-env=METAOBJECTS_ENGINE_SOURCE_HASH={}",
        sha256::hex(&hasher.finish())
    );
    // The crate directories that hash covers, so the skip key can leave a path dependency on
    // one of them out instead of hashing it twice (and only those: matched by directory, not
    // by name, so another checkout of a crate with the same name is still hashed).
    let dirs = [manifest.clone(), manifest.join("../metaobjects")]
        .into_iter()
        .map(|d| std::fs::canonicalize(&d).unwrap_or(d));
    println!(
        "cargo:rustc-env=METAOBJECTS_ENGINE_CRATE_DIRS={}",
        std::env::join_paths(dirs)
            .expect("engine crate directories")
            .to_string_lossy()
    );
}
