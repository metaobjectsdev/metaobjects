//! `eject`: copy a shipped generator into the project, to own (ADR-0034).
//!
//! A generator is a reference helper: the adopter may copy it and change the copy. Rust is a
//! compiled language, so an owned generator cannot be loaded from its source at run time;
//! it is built. `eject` therefore writes a small crate the adopter owns:
//!
//! ```text
//! codegen/
//!   Cargo.toml             depends on the engine; written once, then yours
//!   main.rs                the generator list; written once, then yours
//!   generators/<name>.rs   one owned copy per ejected generator
//! ```
//!
//! While that crate exists, `cargo meta gen` and `cargo meta verify` build and run it, so
//! there is still one way to generate. The copy is the shipped source byte for byte: the
//! shipped generators name the engine by its crate name (`metaobjects_codegen::...`), never
//! `crate::`, which is what lets one text compile in both places.
//!
//! This is not a plugin contract. Nothing discovers or loads a third-party generator, and
//! the engine's Rust API carries no stability promise while the port is in preview: an owned
//! copy is pinned to the engine checkout its `Cargo.toml` points at.
//!
//! Nothing is recorded about an eject. What a project owns is what is on disk under
//! `codegen/generators/`, and "identical" is decided by comparing a copy with the shipped
//! source, as every other port decides it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use metaobjects_codegen::engine::{OWNED_GENERATORS_DIR, OWNED_MAIN, OWNED_MANIFEST};

/// A shipped generator `eject` can hand over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reference {
    /// The name `--generators` and `eject` know it by.
    pub name: &'static str,
    /// Its module (and file stem) under `codegen/generators/`.
    pub module: &'static str,
    /// The generator's type in that module.
    pub type_name: &'static str,
    /// How its output relates to the language: `native` code, or `neutral` pages. One of the
    /// two words the shared generator registry uses.
    pub tier: &'static str,
    /// The layer an adopter selects it by, in the shared generator registry's words.
    pub layer: &'static str,
    /// One line for `gen --list`.
    pub summary: &'static str,
    /// The shipped source, which is also the owned copy's text.
    pub source: &'static str,
}

impl Reference {
    /// Where its owned copy lives, from the project root.
    pub fn owned_path(&self) -> String {
        format!("{OWNED_GENERATORS_DIR}/{}.rs", self.module)
    }

    /// The generator-list entry that runs the shipped generator.
    pub fn shipped_entry(&self) -> String {
        format!("Box::new(metaobjects_codegen::{})", self.type_name)
    }

    /// The generator-list entry that runs the owned copy.
    pub fn owned_entry(&self) -> String {
        format!("Box::new(generators::{}::{})", self.module, self.type_name)
    }
}

/// Every shipped generator, in the order a run applies them.
pub const REFERENCES: &[Reference] = &[
    Reference {
        name: "entity",
        tier: "native",
        layer: "model",
        module: "entity",
        type_name: "EntityGenerator",
        summary: "model crates, one per metadata package: serde structs, enums, value \
                  objects, create and patch inputs, validate()",
        source: include_str!("entity.rs"),
    },
    Reference {
        name: "client",
        tier: "native",
        layer: "client",
        module: "client",
        type_name: "ClientGenerator",
        summary: "client crates, one per package with served entities: a typed HTTP \
                  client and list query per entity (needs entity)",
        source: include_str!("client.rs"),
    },
    Reference {
        name: "commands",
        tier: "native",
        layer: "client",
        module: "commands",
        type_name: "CommandsGenerator",
        summary: "command crates, one per package with served entities: clap commands \
                  over the client (needs entity and client; Rust only)",
        source: include_str!("commands.rs"),
    },
];

/// The shipped generator of that name.
pub fn reference(name: &str) -> Option<&'static Reference> {
    REFERENCES.iter().find(|r| r.name == name)
}

fn names_list() -> String {
    REFERENCES
        .iter()
        .map(|r| r.name)
        .collect::<Vec<_>>()
        .join(", ")
}

/// How an owned copy compares with the shipped generator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyState {
    /// The same non-blank lines in the same order (trailing space ignored).
    Identical,
    /// `behind` shipped lines the copy lacks; `own` lines only the copy has. Both zero means
    /// the same lines in another order.
    Differs { behind: usize, own: usize },
}

impl std::fmt::Display for CopyState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CopyState::Identical => write!(f, "identical"),
            CopyState::Differs { behind: 0, own: 0 } => {
                write!(f, "DIFFERS: 0 behind, 0 of your own, reordered")
            }
            CopyState::Differs { behind, own } => {
                write!(f, "DIFFERS: {behind} behind, {own} of your own")
            }
        }
    }
}

fn meaningful_lines(text: &str) -> Vec<&str> {
    text.lines()
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .collect()
}

/// Compare an owned copy with the shipped text.
pub fn compare(shipped: &str, owned: &str) -> CopyState {
    let a = meaningful_lines(shipped);
    let b = meaningful_lines(owned);
    if a == b {
        return CopyState::Identical;
    }
    let mut counts: HashMap<&str, i64> = HashMap::new();
    for line in &a {
        *counts.entry(line).or_default() += 1;
    }
    for line in &b {
        *counts.entry(line).or_default() -= 1;
    }
    let behind = counts
        .values()
        .filter(|n| **n > 0)
        .map(|n| *n as usize)
        .sum();
    let own = counts
        .values()
        .filter(|n| **n < 0)
        .map(|n| n.unsigned_abs() as usize)
        .sum();
    CopyState::Differs { behind, own }
}

/// An owned copy found on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedCopy {
    pub reference: &'static Reference,
    pub state: CopyState,
}

/// The owned copies in a project, in shipped order. A file under `codegen/generators/` that
/// is not a shipped generator's is the adopter's own generator and is not listed.
pub fn owned_copies(project_root: &Path) -> Vec<OwnedCopy> {
    REFERENCES
        .iter()
        .filter_map(|r| {
            let text = std::fs::read_to_string(project_root.join(r.owned_path())).ok()?;
            Some(OwnedCopy {
                reference: r,
                state: compare(r.source, &text),
            })
        })
        .collect()
}

/// Whether the project runs its own generator crate.
pub fn owns_generators(project_root: &Path) -> bool {
    project_root.join(OWNED_MANIFEST).is_file()
}

/// Why `eject` did nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EjectError {
    /// The request itself was wrong (exit 2).
    Usage(String),
    /// The request was understood and refused to protect the adopter's file (exit 1).
    Refused(String),
    /// A file could not be read or written (exit 1).
    Io(String),
}

impl EjectError {
    /// The process exit status the CLIs share: 2 for a usage error, 1 for a failed run.
    pub fn exit_code(&self) -> i32 {
        match self {
            EjectError::Usage(_) => 2,
            EjectError::Refused(_) | EjectError::Io(_) => 1,
        }
    }
}

impl std::fmt::Display for EjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EjectError::Usage(m) | EjectError::Refused(m) | EjectError::Io(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for EjectError {}

fn io(what: &str, path: &Path, e: &std::io::Error) -> EjectError {
    EjectError::Io(format!("{what} {}: {e}", path.display()))
}

fn resolve(names: &[String]) -> Result<Vec<&'static Reference>, EjectError> {
    let unknown: Vec<&str> = names
        .iter()
        .map(String::as_str)
        .filter(|n| reference(n).is_none())
        .collect();
    if !unknown.is_empty() {
        return Err(EjectError::Usage(format!(
            "unknown or non-ejectable generator(s): {}; ejectable: {}",
            unknown.join(", "),
            names_list()
        )));
    }
    let mut out: Vec<&'static Reference> = Vec::new();
    for r in names.iter().filter_map(|n| reference(n)) {
        if !out.contains(&r) {
            out.push(r);
        }
    }
    Ok(out)
}

/// A path as a TOML basic string.
fn toml_string(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    format!("\"{}\"", text.replace('"', "\\\""))
}

/// The owned crate's manifest. `engine_root` is the directory holding the three engine
/// crates (a checkout's `server/rust`): nothing is published while the port is in preview.
pub fn scaffold_manifest(engine_root: &Path) -> String {
    let dep = |name: &str| toml_string(&engine_root.join(name));
    format!(
        "# The generators this project owns (`cargo meta eject`). This crate is yours.\n\
         # `cargo meta gen` and `cargo meta verify` build and run it while it exists.\n\
         [package]\n\
         name = \"codegen\"\n\
         version = \"0.0.0\"\n\
         edition = \"2024\"\n\
         publish = false\n\
         \n\
         [[bin]]\n\
         name = \"codegen\"\n\
         path = \"main.rs\"\n\
         \n\
         # The Rust port is in preview and nothing is published, so the engine is a path into\n\
         # a checkout. Change these three paths if that checkout moves, or point them at a git\n\
         # revision.\n\
         [dependencies]\n\
         metaobjects = {{ path = {} }}\n\
         metaobjects-cli = {{ path = {} }}\n\
         metaobjects-codegen = {{ path = {} }}\n\
         # What the shipped generators themselves import. Add your own beside it.\n\
         serde_json = {{ version = \"1\", features = [\"preserve_order\"] }}\n\
         \n\
         # The generators run on every `cargo meta gen`: build them optimized, once.\n\
         [profile.dev]\n\
         opt-level = 2\n\
         debug = false\n\
         \n\
         # Its own workspace, so an enclosing one neither claims nor rejects it.\n\
         [workspace]\n",
        dep("metaobjects"),
        dep("metaobjects-cli"),
        dep("metaobjects-codegen"),
    )
}

/// The owned crate's generator list, with `owned` taken from `generators/` and every other
/// generator shipped.
pub fn scaffold_main(owned: &[&Reference]) -> String {
    let mut out = String::from(
        "//! The generators `cargo meta gen` and `cargo meta verify` run for this project.\n\
         //!\n\
         //! This file is yours. Each module under `generators/` is a copy `cargo meta eject` made\n\
         //! of the shipped generator of that name; edit it freely. Keep each generator in the\n\
         //! list once: its owned copy or the shipped one, never both (they write the same files).\n\
         \n\
         use metaobjects_codegen::Generator;\n\
         \n\
         mod generators {\n",
    );
    for r in owned {
        out.push_str(&format!("    pub mod {};\n", r.module));
    }
    out.push_str("}\n\nfn main() {\n    let generators: Vec<Box<dyn Generator>> = vec![\n");
    for r in REFERENCES {
        let entry = if owned.contains(&r) {
            r.owned_entry()
        } else {
            r.shipped_entry()
        };
        out.push_str(&format!("        {entry},\n"));
    }
    out.push_str("    ];\n    std::process::exit(metaobjects_cli::owned_main(generators));\n}\n");
    out
}

fn write_new(path: &Path, text: &str) -> Result<(), EjectError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| io("creating", dir, &e))?;
    }
    std::fs::write(path, text).map_err(|e| io("writing", path, &e))
}

/// Copy the named generators into `codegen/generators/`, scaffolding the owned crate around
/// them when it is not there. Returns the lines to print. Every name is checked before
/// anything is written, and a file the adopter already has is never changed: a copy only
/// with `force`, `Cargo.toml` and `main.rs` never.
pub fn eject(
    project_root: &Path,
    names: &[String],
    force: bool,
    engine_root: &Path,
) -> Result<Vec<String>, EjectError> {
    if names.is_empty() {
        return Err(EjectError::Usage(
            "name at least one generator to eject (`cargo meta gen --list` shows them), or pass --undo"
                .to_string(),
        ));
    }
    let wanted = resolve(names)?;
    let existing: Vec<String> = wanted
        .iter()
        .map(|r| r.owned_path())
        .filter(|p| project_root.join(p).exists())
        .collect();
    if !existing.is_empty() && !force {
        return Err(EjectError::Refused(format!(
            "already owned: {}. Eject never overwrites your copy; pass --force to replace it \
             (and discard any edits) with the reference.",
            existing.join(", ")
        )));
    }

    let mut lines = Vec::new();
    for r in &wanted {
        let rel = r.owned_path();
        let replaced = project_root.join(&rel).exists();
        write_new(&project_root.join(&rel), r.source)?;
        lines.push(format!(
            "ejected {} -> {rel} [{}]",
            r.name,
            if replaced { "replaced" } else { "created" }
        ));
    }

    let manifest = project_root.join(OWNED_MANIFEST);
    if manifest.exists() {
        lines.push(format!("  kept {OWNED_MANIFEST} (already yours)"));
    } else {
        write_new(&manifest, &scaffold_manifest(engine_root))?;
        lines.push(format!(
            "  wrote {OWNED_MANIFEST} (the engine is the checkout at {})",
            engine_root.display()
        ));
    }
    let main = project_root.join(OWNED_MAIN);
    if main.exists() {
        lines.push(format!(
            "{OWNED_MAIN} already exists and is yours: eject never edits it. In it:"
        ));
        for r in &wanted {
            lines.push(format!(
                "  add `pub mod {};` inside `mod generators`",
                r.module
            ));
            lines.push(format!(
                "  replace `{}` with `{}`",
                r.shipped_entry(),
                r.owned_entry()
            ));
        }
    } else {
        let owned: Vec<&Reference> = owned_copies(project_root)
            .into_iter()
            .map(|c| c.reference)
            .collect();
        write_new(&main, &scaffold_main(&owned))?;
        lines.push(format!("  wrote {OWNED_MAIN} (the generator list)"));
    }
    lines.push(
        "The copies are yours: edit them freely. `cargo meta gen` and `cargo meta verify` now \
         build and run the codegen/ crate; `cargo meta gen --list` reports how far an owned copy \
         has drifted from the reference."
            .to_string(),
    );
    Ok(lines)
}

/// Remove owned copies that are still identical to the shipped generator. With no names,
/// every identical copy; with names, exactly those, and a copy that differs is refused
/// unless `force`. Returns the lines to print. Nothing is removed unless every name is.
pub fn undo(project_root: &Path, names: &[String], force: bool) -> Result<Vec<String>, EjectError> {
    let copies = owned_copies(project_root);
    let chosen: Vec<OwnedCopy> = if names.is_empty() {
        let identical: Vec<OwnedCopy> = copies
            .iter()
            .filter(|c| c.state == CopyState::Identical || force)
            .cloned()
            .collect();
        if identical.is_empty() {
            return Ok(vec![if copies.is_empty() {
                format!("no owned generator copies under {OWNED_GENERATORS_DIR}/; nothing to undo.")
            } else {
                format!(
                    "no owned copy is identical to its shipped generator, so nothing was removed: {}. \
                     Pass --force to discard your edits.",
                    copies
                        .iter()
                        .map(|c| format!("{} ({})", c.reference.name, c.state))
                        .collect::<Vec<_>>()
                        .join("; ")
                )
            }]);
        }
        identical
    } else {
        let wanted = resolve(names)?;
        let missing: Vec<&str> = wanted
            .iter()
            .filter(|r| !copies.iter().any(|c| c.reference == **r))
            .map(|r| r.name)
            .collect();
        if !missing.is_empty() {
            return Err(EjectError::Usage(format!(
                "no owned copy of: {} (nothing at {OWNED_GENERATORS_DIR}/). Nothing was removed.",
                missing.join(", ")
            )));
        }
        let chosen: Vec<OwnedCopy> = copies
            .iter()
            .filter(|c| wanted.contains(&c.reference))
            .cloned()
            .collect();
        let differing: Vec<String> = chosen
            .iter()
            .filter(|c| c.state != CopyState::Identical)
            .map(|c| format!("{} ({})", c.reference.name, c.state))
            .collect();
        if !differing.is_empty() && !force {
            return Err(EjectError::Usage(format!(
                "not removed (nothing was changed): {}. Undo drops only copies identical to the \
                 shipped generator. Pass --force to discard your edits.",
                differing.join("; ")
            )));
        }
        chosen
    };

    let mut lines = Vec::new();
    for c in &chosen {
        let rel = c.reference.owned_path();
        let path = project_root.join(&rel);
        std::fs::remove_file(&path).map_err(|e| io("removing", &path, &e))?;
        lines.push(format!("removed {rel}"));
    }
    // An emptied `generators/` goes too; anything else in it is the adopter's and stays.
    let _ = std::fs::remove_dir(project_root.join(OWNED_GENERATORS_DIR));
    if project_root.join(OWNED_MAIN).exists() {
        lines.push(format!(
            "{OWNED_MAIN} is yours: undo never edits it. In it (the crate does not build until you do):"
        ));
        for c in &chosen {
            lines.push(format!("  remove `pub mod {};`", c.reference.module));
            lines.push(format!(
                "  replace `{}` with `{}`",
                c.reference.owned_entry(),
                c.reference.shipped_entry()
            ));
        }
    }
    if owned_copies(project_root).is_empty() && owns_generators(project_root) {
        lines.push(
            "No owned generator is left. Delete the codegen/ directory to go back to running the \
             shipped generators directly."
                .to_string(),
        );
    }
    Ok(lines)
}

/// The directory an owned crate's engine paths default to: the `server/rust` of the checkout
/// this binary was built from.
pub fn default_engine_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}
