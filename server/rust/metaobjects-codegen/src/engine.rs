//! The run engine: load, plan, skip, render, write.
//!
//! One run is five stages, each timed the way a load is (`LoadTimings`, no thresholds):
//!
//! | stage    | what it does |
//! |----------|--------------|
//! | `load`   | resolve the project, read its files, load and validate the model |
//! | `plan`   | hash the model and every input into the skip key; read the manifest |
//! | `skip`   | when the key matches the stored one, check every recorded file still has the bytes the last run left |
//! | `render` | run the generators (in memory) |
//! | `write`  | write only files whose bytes changed; save the manifest once; store the key |
//!
//! A run that skips records `load`, `plan` and `skip` only: it renders nothing and writes
//! nothing, not even the manifest or the stored key (ADR-0064).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use metaobjects::errors::MetaError;
use metaobjects::sources::{CONFIG_FILE, DEFAULT_METAOBJECTS_DIR};
use metaobjects::timing::LoadTimings;

use crate::fingerprint::{
    self, ABSENT, InputEntry, KIND_CONFIG, KIND_ENGINE, KIND_EXTRA, KIND_FLAG, KIND_GENERATOR,
    KIND_MODEL, KIND_TOOL, build_model_tree, fold, hash_file, hash_tree,
};
use crate::generator::{
    ERR_OUT_DIR, ERR_PATH_COLLISION, EmittedFile, GenContext, GenError, Generator,
};
use crate::hashes::{HashManifest, content_hash};
use crate::project::load_project;
use crate::sha256::sha256_hex;

pub const STAGE_LOAD: &str = "load";
pub const STAGE_PLAN: &str = "plan";
pub const STAGE_SKIP: &str = "skip";
pub const STAGE_RENDER: &str = "render";
pub const STAGE_WRITE: &str = "write";

/// The gen-state directory beneath a project's `.metaobjects`.
pub const GEN_STATE_DIR: &str = ".gen-state";

/// The hash of this engine's own sources and the loader's, taken when it was built.
pub const ENGINE_SOURCE_HASH: &str = env!("METAOBJECTS_ENGINE_SOURCE_HASH");

/// What one run was asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOptions {
    /// Where project discovery starts (the nearest `.metaobjects/config.json` upward).
    pub start_dir: PathBuf,
    /// A project root named outright (`--project`), skipping discovery.
    pub project_dir: Option<PathBuf>,
    /// The output directory, relative to the project root unless absolute; it must lie
    /// inside the project.
    pub out_dir: PathBuf,
    /// Render even when the skip key matches (`--force`).
    pub force: bool,
    /// Load strictly (ADR-0023).
    pub strict: bool,
    /// Object names the run is limited to. Such a run never skips and never stores a key.
    pub entities: Vec<String>,
    /// Generator names to run; `None` runs them all.
    pub generators: Option<Vec<String>>,
}

impl RunOptions {
    pub fn new(start_dir: impl Into<PathBuf>) -> Self {
        Self {
            start_dir: start_dir.into(),
            project_dir: None,
            out_dir: PathBuf::from("generated"),
            force: false,
            strict: false,
            entities: Vec::new(),
            generators: None,
        }
    }
}

/// How the run ended, when it did not fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The skip key matched: nothing was rendered or written.
    Skipped,
    /// The generators ran and the files were reconciled with disk.
    Generated,
}

/// What a run did to each file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileCounts {
    /// Files that did not exist before.
    pub created: usize,
    /// Files whose bytes changed.
    pub overwritten: usize,
    /// Files whose fresh bytes equal what is on disk, left untouched.
    pub unchanged: usize,
    /// Generated files no longer emitted, removed.
    pub removed: usize,
}

/// The result of a run that did not fail.
#[derive(Debug, Clone)]
pub struct RunReport {
    pub outcome: Outcome,
    /// `load`, `plan`, `skip`, `render`, `write`, in the order they ran.
    pub timings: LoadTimings,
    /// The load's own phases and validation passes.
    pub load_timings: LoadTimings,
    pub files: FileCounts,
    /// Whether the manifest was rewritten.
    pub manifest_written: bool,
    /// Why the run did not skip, when it did not.
    pub no_skip_reason: Option<&'static str>,
    /// Warnings from the load, the config and the run.
    pub warnings: Vec<String>,
    /// The project root the run used.
    pub project_root: PathBuf,
}

/// Why a run failed.
#[derive(Debug)]
pub enum RunError {
    /// The project did not resolve or the model did not load.
    Load(Vec<MetaError>),
    /// A generator failed.
    Generator(GenError),
    /// Existing files are not what a previous run left (hand-edited, or unrecorded), so
    /// they were left alone. The rest of the run completed.
    Refused(Vec<String>),
    /// A file could not be read or written.
    Io(String),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::Load(errors) => {
                for (i, e) in errors.iter().enumerate() {
                    if i > 0 {
                        writeln!(f)?;
                    }
                    write!(f, "{e}")?;
                }
                Ok(())
            }
            RunError::Generator(e) => write!(f, "{e}"),
            RunError::Refused(paths) => write!(
                f,
                "refused to overwrite {} file(s) that differ from what the last run wrote \
                 (edited by hand, or not recorded in {DEFAULT_METAOBJECTS_DIR}/{GEN_STATE_DIR}/.hashes.json): {}. \
                 Restore them, or delete them to generate them afresh.",
                paths.len(),
                paths.join(", ")
            ),
            RunError::Io(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for RunError {}

fn rel_key(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    Some(
        rel.components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

/// Collapse `.` and `..` lexically (the out dir need not exist yet).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn io_error(what: &str, path: &Path, e: &std::io::Error) -> RunError {
    RunError::Io(format!("{what} {}: {e}", path.display()))
}

/// Run `generators` over the project: the whole pipeline.
pub fn run(opts: &RunOptions, generators: &[Box<dyn Generator>]) -> Result<RunReport, RunError> {
    let mut timings = LoadTimings::default();

    // load
    let start = Instant::now();
    let loaded = load_project(&opts.start_dir, opts.project_dir.as_deref(), opts.strict)
        .map_err(RunError::Load)?;
    timings.add_phase(STAGE_LOAD, start.elapsed());
    let project_root = loaded.collection.config_dir.clone();
    let mut warnings = loaded.collection.warnings.clone();
    warnings.extend(loaded.result.warnings.iter().map(ToString::to_string));
    let load_timings = loaded.result.timings.clone();

    // plan
    let start = Instant::now();
    let selected: Vec<&dyn Generator> = match &opts.generators {
        None => generators.iter().map(AsRef::as_ref).collect(),
        Some(names) => generators
            .iter()
            .map(AsRef::as_ref)
            .filter(|g| names.iter().any(|n| n == g.name()))
            .collect(),
    };
    let out_dir = normalize(&if opts.out_dir.is_absolute() {
        opts.out_dir.clone()
    } else {
        project_root.join(&opts.out_dir)
    });
    let out_rel = rel_key(&normalize(&project_root), &out_dir).ok_or_else(|| {
        RunError::Generator(GenError::new(
            ERR_OUT_DIR,
            format!(
                "the output directory {} is outside the project {}; the hash manifest keys every file by its path from the project root",
                out_dir.display(),
                project_root.display()
            ),
        ))
    })?;
    if out_rel.is_empty() {
        return Err(RunError::Generator(GenError::new(
            ERR_OUT_DIR,
            format!(
                "the output directory {} is the project root; it must be a sub-directory of the project, because the shared hash manifest keys every port's files and the stale-file sweep may only touch files under a prefix this port owns",
                out_dir.display()
            ),
        )));
    }
    let gen_state = project_root
        .join(DEFAULT_METAOBJECTS_DIR)
        .join(GEN_STATE_DIR);
    let mut manifest = HashManifest::load(&gen_state);
    let model = build_model_tree(&loaded.result.tree, loaded.result.root);
    let cacheable = selected.iter().all(|g| g.cacheable());
    let mut entries = vec![
        InputEntry::new(
            KIND_TOOL,
            "fingerprint-format",
            fingerprint::FINGERPRINT_FORMAT.to_string(),
        ),
        InputEntry::new(KIND_TOOL, "engine-version", env!("CARGO_PKG_VERSION")),
        InputEntry::new(KIND_ENGINE, "metaobjects-codegen", ENGINE_SOURCE_HASH),
        InputEntry::new(
            KIND_CONFIG,
            "project-config",
            hash_file(&project_root.join(DEFAULT_METAOBJECTS_DIR).join(CONFIG_FILE)),
        ),
        InputEntry::new(KIND_MODEL, "model", model.model.clone()),
        InputEntry::new(KIND_FLAG, "out", out_rel.clone()),
        InputEntry::new(KIND_FLAG, "strict", opts.strict.to_string()),
    ];
    let mut names: Vec<&str> = selected.iter().map(|g| g.name()).collect();
    names.sort_unstable();
    entries.push(InputEntry::new(KIND_FLAG, "generators", names.join(",")));
    for g in &selected {
        entries.push(InputEntry::new(
            KIND_GENERATOR,
            g.name(),
            sha256_hex(g.identity().as_bytes()),
        ));
        for extra in g.extra_inputs() {
            let digest = hash_tree(&project_root.join(&extra));
            entries.push(InputEntry::new(KIND_EXTRA, extra, digest));
        }
    }
    let key = fold(&entries);
    let stored = fingerprint::read_stored(&gen_state);
    timings.add_phase(STAGE_PLAN, start.elapsed());

    // skip
    let named = !opts.entities.is_empty();
    let no_skip_reason = if opts.force {
        Some("--force")
    } else if named {
        Some("entities were named")
    } else if !cacheable {
        Some("a generator is not cacheable")
    } else {
        match &stored {
            None => Some("no stored key"),
            Some(s) if s.key != key => Some("an input changed"),
            Some(_) => None,
        }
    };
    let mut no_skip_reason = no_skip_reason;
    if no_skip_reason.is_none() {
        let start = Instant::now();
        let unchanged = stored.as_ref().is_some_and(|s| {
            fingerprint::output_hashes(&manifest, &project_root).as_ref() == Some(&s.outputs)
        });
        timings.add_phase(STAGE_SKIP, start.elapsed());
        if unchanged {
            return Ok(RunReport {
                outcome: Outcome::Skipped,
                timings,
                load_timings,
                files: FileCounts::default(),
                manifest_written: false,
                no_skip_reason: None,
                warnings,
                project_root,
            });
        }
        no_skip_reason = Some("a generated file changed or is missing");
    }

    // A run that goes on to write deletes the stored key first, so a failed or half-written
    // run is never mistaken for a current one. A named run leaves the full-run key alone.
    if !named {
        fingerprint::delete_stored(&gen_state);
    }

    // render
    let start = Instant::now();
    let ctx = GenContext {
        tree: &loaded.result.tree,
        root: loaded.result.root,
        entities: &opts.entities,
    };
    let mut emitted: Vec<EmittedFile> = Vec::new();
    for g in &selected {
        emitted.extend(g.generate(&ctx).map_err(RunError::Generator)?);
    }
    timings.add_phase(STAGE_RENDER, start.elapsed());

    // write
    let start = Instant::now();
    let mut seen: HashSet<&str> = HashSet::with_capacity(emitted.len());
    for f in &emitted {
        if !seen.insert(f.path.as_str()) {
            return Err(RunError::Generator(GenError::new(
                ERR_PATH_COLLISION,
                format!("two generated files claim the path {}", f.path),
            )));
        }
    }
    let mut files = FileCounts::default();
    let mut refused: Vec<String> = Vec::new();
    let mut known_dirs: HashSet<PathBuf> = HashSet::new();
    let mut written_hashes: BTreeMap<String, String> = BTreeMap::new();
    for f in &emitted {
        let key = format!("{out_rel}/{}", f.path);
        let path = project_root.join(&key);
        let fresh_hash = content_hash(&f.content);
        match std::fs::read(&path) {
            Ok(disk) if disk == f.content.as_bytes() => {
                files.unchanged += 1;
                manifest.record(&key, &fresh_hash);
            }
            Ok(disk) => {
                let disk_hash = sha256_hex(&disk);
                if manifest.hash_of(&key) == Some(disk_hash.as_str()) {
                    std::fs::write(&path, &f.content)
                        .map_err(|e| io_error("writing", &path, &e))?;
                    files.overwritten += 1;
                    manifest.record(&key, &fresh_hash);
                } else {
                    refused.push(key.clone());
                    continue;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if let Some(dir) = path.parent()
                    && known_dirs.insert(dir.to_path_buf())
                {
                    std::fs::create_dir_all(dir).map_err(|e| io_error("creating", dir, &e))?;
                }
                std::fs::write(&path, &f.content).map_err(|e| io_error("writing", &path, &e))?;
                files.created += 1;
                manifest.record(&key, &fresh_hash);
            }
            Err(e) => return Err(io_error("reading", &path, &e)),
        }
        written_hashes.insert(key, fresh_hash);
    }

    // Generated files this run no longer emits (a package that went away) are removed when
    // they are still exactly what a run wrote; one with an edit is kept and reported. A run
    // limited to some generators (or some objects) cannot tell a file nobody emits any more
    // from a file another generator emits, so it sweeps nothing.
    if !named && opts.generators.is_none() {
        let prefix = format!("{out_rel}/");
        let stale: Vec<(String, String)> = manifest
            .records()
            .filter(|(k, _)| k.starts_with(&prefix) && !written_hashes.contains_key(*k))
            .map(|(k, h)| (k.to_string(), h.to_string()))
            .collect();
        for (key, recorded) in stale {
            let path = project_root.join(&key);
            match std::fs::read(&path) {
                Ok(disk) if sha256_hex(&disk) == recorded => {
                    std::fs::remove_file(&path).map_err(|e| io_error("removing", &path, &e))?;
                    remove_empty_parents(&path, &out_dir);
                    manifest.remove(&key);
                    files.removed += 1;
                }
                Ok(_) => warnings.push(format!(
                    "{key} is no longer generated but differs from what the last run wrote, so it was kept"
                )),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => manifest.remove(&key),
                Err(e) => return Err(io_error("reading", &path, &e)),
            }
        }
    }

    // The manifest is written once, and only when a record changed. It is written even when a
    // file was refused: every record in it is on disk.
    let manifest_written = manifest
        .save()
        .map_err(|e| io_error("writing", &gen_state.join(".hashes.json"), &e))?;
    if !refused.is_empty() {
        return Err(RunError::Refused(refused));
    }

    // Store the key only for a full run, with every generator cacheable.
    if !named && cacheable {
        let mut outputs: BTreeMap<String, String> = BTreeMap::new();
        for (key, _) in manifest.records() {
            let digest = match written_hashes.get(key) {
                Some(h) => h.clone(),
                None => std::fs::read(project_root.join(key))
                    .map(|b| sha256_hex(&b))
                    .unwrap_or_else(|_| ABSENT.to_string()),
            };
            outputs.insert(key.to_string(), digest);
        }
        fingerprint::write_stored(&gen_state, &key, &outputs)
            .map_err(|e| io_error("writing", &gen_state, &e))?;
    }
    timings.add_phase(STAGE_WRITE, start.elapsed());

    Ok(RunReport {
        outcome: Outcome::Generated,
        timings,
        load_timings,
        files,
        manifest_written,
        no_skip_reason,
        warnings,
        project_root,
    })
}

/// Remove the now-empty directories above `path`, stopping at (and keeping) `stop`.
fn remove_empty_parents(path: &Path, stop: &Path) {
    let mut cur = path.parent();
    while let Some(dir) = cur {
        if dir == stop || !dir.starts_with(stop) {
            break;
        }
        if std::fs::remove_dir(dir).is_err() {
            break;
        }
        cur = dir.parent();
    }
}
