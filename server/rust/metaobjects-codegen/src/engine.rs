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
//!
//! [`verify`] is the same pipeline with the last stage swapped: it renders in memory and
//! compares with disk (`compare`), and writes nothing at all.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use metaobjects::errors::MetaError;
use metaobjects::rules_check::{RulesCheckResult, check_rules};
use metaobjects::sources::{CONFIG_FILE, DEFAULT_METAOBJECTS_DIR};
use metaobjects::timing::LoadTimings;
use metaobjects::validate::util::ObjectIndex;

use crate::fingerprint::{
    self, ABSENT, InputEntry, KIND_CONFIG, KIND_ENGINE, KIND_EXTRA, KIND_FLAG, KIND_GENERATOR,
    KIND_MODEL, KIND_TOOL, StoredFingerprint, build_model_tree, fold, hash_file, hash_tree,
    hash_tree_except,
};
use crate::generator::{
    ERR_OUT_DIR, ERR_PATH_COLLISION, EmittedFile, GenContext, GenError, Generator,
};
use crate::generator_list;
use crate::hashes::{HASHES_DIR, HashManifest, content_hash};
use crate::project::{LoadedProject, load_project};
use crate::sha256::sha256_hex;

pub const STAGE_LOAD: &str = "load";
pub const STAGE_PLAN: &str = "plan";
pub const STAGE_SKIP: &str = "skip";
pub const STAGE_RENDER: &str = "render";
pub const STAGE_WRITE: &str = "write";
pub const STAGE_COMPARE: &str = "compare";

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

/// What a run did to one file it changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    Created,
    Updated,
    Removed,
}

/// One entry of the change report: a file the run created, rewrote or removed. A file whose
/// bytes did not change is not in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    /// The file's path from the project root, `/`-separated.
    pub path: String,
    pub kind: ChangeKind,
}

impl Change {
    fn new(path: &str, kind: ChangeKind) -> Self {
        Self {
            path: path.to_string(),
            kind,
        }
    }
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
    /// The change report: every file the run created, rewrote or removed, in the order it
    /// did so. Empty when the run skipped or nothing changed.
    pub changes: Vec<Change>,
    /// The output directory, from the project root.
    pub out_rel: String,
    /// Whether the manifest was rewritten.
    pub manifest_written: bool,
    /// Why the run did not skip, when it did not.
    pub no_skip_reason: Option<&'static str>,
    /// Warnings from the load, the config and the run.
    pub warnings: Vec<String>,
    /// The project root the run used.
    pub project_root: PathBuf,
}

impl RunReport {
    /// The directories directly under the output directory that hold a changed file, sorted.
    /// The generators write one crate per directory, so this is the list of crates a build
    /// has to look at again (`cargo check -p <each>`); every other crate is byte-identical.
    pub fn changed_roots(&self) -> Vec<String> {
        let prefix = format!("{}/", self.out_rel);
        let mut roots: Vec<String> = self
            .changes
            .iter()
            .filter_map(|c| c.path.strip_prefix(&prefix))
            .filter_map(|rest| rest.split_once('/').map(|(root, _)| root.to_string()))
            .collect();
        roots.sort_unstable();
        roots.dedup();
        roots
    }
}

/// The files a run would not touch because a person changed them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Refusal {
    /// Files the run emits whose bytes on disk are not what a run wrote (edited by hand, or
    /// never recorded). They were not overwritten.
    pub edited: Vec<String>,
    /// Recorded files the run no longer emits that were edited by hand. They were not deleted.
    pub orphans: Vec<String>,
}

impl Refusal {
    pub fn is_empty(&self) -> bool {
        self.edited.is_empty() && self.orphans.is_empty()
    }
}

/// Why a run failed.
#[derive(Debug)]
pub enum RunError {
    /// The project did not resolve or the model did not load.
    Load(Vec<MetaError>),
    /// A generator failed.
    Generator(GenError),
    /// Existing files are not what a previous run left (hand-edited, or unrecorded), so
    /// they were left alone. The rest of the run completed, and no skip key was stored.
    Refused(Refusal),
    /// The project's generator list (`metaobjects.config.json`) is wrong.
    GeneratorList(String),
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
            RunError::Refused(r) => {
                if !r.edited.is_empty() {
                    write!(
                        f,
                        "refused to overwrite {} file(s) that differ from what the last run wrote \
                         (edited by hand, or not recorded in {DEFAULT_METAOBJECTS_DIR}/{GEN_STATE_DIR}/.hashes/): {}. \
                         Restore them, or delete them to generate them afresh.",
                        r.edited.len(),
                        r.edited.join(", ")
                    )?;
                }
                if !r.edited.is_empty() && !r.orphans.is_empty() {
                    writeln!(f)?;
                }
                if !r.orphans.is_empty() {
                    write!(
                        f,
                        "{} generated file(s) are no longer generated but have been edited by hand, \
                         so they were NOT deleted: {}. Delete each one, or move your edits into a \
                         file of your own first.",
                        r.orphans.len(),
                        r.orphans.join(", ")
                    )?;
                }
                Ok(())
            }
            RunError::GeneratorList(m) | RunError::Io(m) => write!(f, "{m}"),
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

/// The owned generator crate (`cargo meta eject`). Every source in it is an input of every
/// run, so editing any of them regenerates (ADR-0064, `owned-generator-edited`).
pub const OWNED_DIR: &str = "codegen";
/// What in [`OWNED_DIR`] is not an input: cargo's build output, and the lockfile cargo
/// itself rewrites.
pub const OWNED_NOT_INPUTS: &[&str] = &["target", "Cargo.lock"];
/// Where `cargo meta eject` puts the owned copies.
pub const OWNED_GENERATORS_DIR: &str = "codegen/generators";
/// The owned crate's manifest; its presence is what makes a project "own its generators".
pub const OWNED_MANIFEST: &str = "codegen/Cargo.toml";
/// The owned crate's generator list.
pub const OWNED_MAIN: &str = "codegen/main.rs";

/// Everything a run knows before it renders: the loaded model, where the files go, the
/// manifest and the skip key.
/// A generator the run applies: one the host offered, or the one an entry's options
/// constructed in its place.
enum Selected<'g> {
    Offered(&'g dyn Generator),
    Configured(Box<dyn Generator>),
}

impl<'g> std::ops::Deref for Selected<'g> {
    type Target = dyn Generator + 'g;

    fn deref(&self) -> &Self::Target {
        match self {
            Selected::Offered(g) => *g,
            Selected::Configured(g) => g.as_ref(),
        }
    }
}

struct Prepared<'g> {
    loaded: LoadedProject,
    project_root: PathBuf,
    out_dir: PathBuf,
    out_rel: String,
    gen_state: PathBuf,
    manifest: HashManifest,
    selected: Vec<Selected<'g>>,
    cacheable: bool,
    key: String,
    stored: Option<StoredFingerprint>,
    warnings: Vec<String>,
    timings: LoadTimings,
}

impl Prepared<'_> {
    /// The manifest key of a generated file: its path from the project root.
    fn key_of(&self, file: &EmittedFile) -> String {
        format!("{}/{}", self.out_rel, file.path)
    }

    /// Whether every recorded file still has the bytes the last successful run left, under
    /// the same key: the whole "nothing changed" answer.
    fn unchanged_since_last_run(&self) -> bool {
        self.stored.as_ref().is_some_and(|s| {
            s.key == self.key
                && fingerprint::output_hashes(&self.manifest, &self.project_root).as_ref()
                    == Some(&s.outputs)
        })
    }

    /// Recorded files under the output directory that this run did not emit, with the hash
    /// the manifest holds for each.
    fn not_emitted(&self, emitted: &HashSet<String>) -> Vec<(String, String)> {
        let prefix = format!("{}/", self.out_rel);
        self.manifest
            .records()
            .filter(|(k, _)| k.starts_with(&prefix) && !emitted.contains(*k))
            .map(|(k, h)| (k.to_string(), h.to_string()))
            .collect()
    }
}

/// A run limited to some objects or some generators cannot tell a file nobody emits any
/// more from a file the rest of the run would emit, so it neither sweeps nor reports extras.
fn narrowed(opts: &RunOptions) -> bool {
    !opts.entities.is_empty() || opts.generators.is_some()
}

fn prepare<'g>(
    opts: &RunOptions,
    generators: &'g [Box<dyn Generator>],
) -> Result<Prepared<'g>, RunError> {
    let mut timings = LoadTimings::default();

    // load
    let start = Instant::now();
    let loaded = load_project(&opts.start_dir, opts.project_dir.as_deref(), opts.strict)
        .map_err(RunError::Load)?;
    timings.add_phase(STAGE_LOAD, start.elapsed());
    let project_root = loaded.collection.config_dir.clone();
    let mut warnings = loaded.collection.warnings.clone();
    warnings.extend(loaded.result.warnings.iter().map(ToString::to_string));

    // plan
    let start = Instant::now();
    // The project's own list narrows what the host offers; `--generators` narrows it again,
    // but only within the list, so a flag never runs what the project left out.
    let entries = generator_list::read(&project_root).map_err(RunError::GeneratorList)?;
    let listed = entries.as_deref().map(generator_list::names);
    if let Some(names) = &listed {
        let available: Vec<&str> = generators.iter().map(|g| g.name()).collect();
        generator_list::check(names, &available).map_err(RunError::GeneratorList)?;
    }
    if let (Some(listed), Some(flagged)) = (&listed, &opts.generators)
        && let Some(out) = flagged.iter().find(|n| !listed.contains(n))
    {
        return Err(RunError::GeneratorList(format!(
            "the generator {out} is not in the \"generators\" list of {}; the project runs: {}",
            generator_list::GENERATOR_LIST_FILE,
            listed.join(", ")
        )));
    }
    // An entry with options constructs its generator from them, and that one runs in the
    // offered generator's place; a generator refuses an option it does not take.
    let mut selected: Vec<Selected<'g>> = Vec::with_capacity(generators.len());
    for g in generators {
        let in_list = listed
            .as_ref()
            .is_none_or(|l| l.iter().any(|n| n == g.name()));
        let flagged = opts
            .generators
            .as_ref()
            .is_none_or(|names| names.iter().any(|n| n == g.name()));
        if !in_list {
            continue;
        }
        let options = entries
            .as_deref()
            .and_then(|es| es.iter().find(|e| e.name == g.name()))
            .map(|e| &e.options)
            .filter(|o| !o.is_empty());
        // Every listed entry's options are checked, even on a run `--generators` narrows, so
        // a misspelt option fails the first run rather than the first one that includes it.
        let chosen = match options {
            Some(o) => Selected::Configured(g.configure(o).map_err(RunError::Generator)?),
            None => Selected::Offered(g.as_ref()),
        };
        if flagged {
            selected.push(chosen);
        }
    }
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
    // The model's root-level objects decide which package's manifest file records a path.
    // ADR-0039 sanctioned own: a top-level scan of the loader ROOT, as in `build_model_tree`.
    let tree = &loaded.result.tree;
    manifest.set_objects(
        tree.own_children(loaded.result.root)
            .iter()
            .filter(|&&c| tree.node(c).type_name == "object")
            .map(|&c| (tree.node(c).name.clone(), tree.effective_package(c)))
            .collect(),
    );
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
    // The owned generator crate, whole: the generator list is the adopter's file and may pull
    // in any module beside it (`mod util;`), so naming the files the scaffold writes would
    // leave an edit to the rest unseen and the skip stale.
    if project_root.join(OWNED_MANIFEST).is_file() {
        entries.push(InputEntry::new(
            KIND_EXTRA,
            OWNED_DIR,
            hash_tree_except(&project_root.join(OWNED_DIR), OWNED_NOT_INPUTS),
        ));
    }
    let key = fold(&entries);
    let stored = fingerprint::read_stored(&gen_state);
    timings.add_phase(STAGE_PLAN, start.elapsed());

    Ok(Prepared {
        loaded,
        project_root,
        out_dir,
        out_rel,
        gen_state,
        manifest,
        selected,
        cacheable,
        key,
        stored,
        warnings,
        timings,
    })
}

/// Run the selected generators in memory. Two files claiming one path is an error.
fn render(p: &mut Prepared<'_>, opts: &RunOptions) -> Result<Vec<EmittedFile>, RunError> {
    let start = Instant::now();
    let ctx = GenContext {
        tree: &p.loaded.result.tree,
        root: p.loaded.result.root,
        entities: &opts.entities,
        collection: &p.loaded.collection,
    };
    let mut emitted: Vec<EmittedFile> = Vec::new();
    for g in &p.selected {
        emitted.extend(g.generate(&ctx).map_err(RunError::Generator)?);
    }
    let mut seen: HashSet<&str> = HashSet::with_capacity(emitted.len());
    for f in &emitted {
        if !seen.insert(f.path.as_str()) {
            return Err(RunError::Generator(GenError::new(
                ERR_PATH_COLLISION,
                format!("two generated files claim the path {}", f.path),
            )));
        }
    }
    p.timings.add_phase(STAGE_RENDER, start.elapsed());
    Ok(emitted)
}

/// Run `generators` over the project: the whole pipeline.
pub fn run(opts: &RunOptions, generators: &[Box<dyn Generator>]) -> Result<RunReport, RunError> {
    let mut p = prepare(opts, generators)?;
    let load_timings = p.loaded.result.timings.clone();

    // skip
    let named = !opts.entities.is_empty();
    let mut no_skip_reason = if opts.force {
        Some("--force")
    } else if named {
        Some("entities were named")
    } else if !p.cacheable {
        Some("a generator is not cacheable")
    } else if p.manifest.is_legacy() {
        // A legacy single-file manifest is migrated by a run that writes (ADR-0064 Amendment 1).
        Some("the manifest is the legacy single file")
    } else {
        match &p.stored {
            None => Some("no stored key"),
            Some(s) if s.key != p.key => Some("an input changed"),
            Some(_) => None,
        }
    };
    if no_skip_reason.is_none() {
        let start = Instant::now();
        let unchanged = p.unchanged_since_last_run();
        p.timings.add_phase(STAGE_SKIP, start.elapsed());
        if unchanged {
            return Ok(RunReport {
                outcome: Outcome::Skipped,
                timings: p.timings,
                load_timings,
                files: FileCounts::default(),
                changes: Vec::new(),
                out_rel: p.out_rel,
                manifest_written: false,
                no_skip_reason: None,
                warnings: p.warnings,
                project_root: p.project_root,
            });
        }
        no_skip_reason = Some("a generated file changed or is missing");
    }

    // A run that goes on to write deletes the stored key first, so a failed or half-written
    // run is never mistaken for a current one. A named run leaves the full-run key alone.
    if !named {
        fingerprint::delete_stored(&p.gen_state);
    }

    let emitted = render(&mut p, opts)?;

    // write
    let start = Instant::now();
    let mut files = FileCounts::default();
    let mut changes: Vec<Change> = Vec::new();
    let mut refusal = Refusal::default();
    let mut known_dirs: HashSet<PathBuf> = HashSet::new();
    let mut written_hashes: BTreeMap<String, String> = BTreeMap::new();
    for f in &emitted {
        let key = p.key_of(f);
        let path = p.project_root.join(&key);
        let fresh_hash = content_hash(&f.content);
        match std::fs::read(&path) {
            Ok(disk) if disk == f.content.as_bytes() => {
                files.unchanged += 1;
                p.manifest.record(&key, &fresh_hash);
            }
            Ok(disk) => {
                let disk_hash = sha256_hex(&disk);
                if p.manifest.hash_of(&key) == Some(disk_hash.as_str()) {
                    std::fs::write(&path, &f.content)
                        .map_err(|e| io_error("writing", &path, &e))?;
                    files.overwritten += 1;
                    changes.push(Change::new(&key, ChangeKind::Updated));
                    p.manifest.record(&key, &fresh_hash);
                } else {
                    refusal.edited.push(key.clone());
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
                changes.push(Change::new(&key, ChangeKind::Created));
                p.manifest.record(&key, &fresh_hash);
            }
            Err(e) => return Err(io_error("reading", &path, &e)),
        }
        written_hashes.insert(key, fresh_hash);
    }

    // The orphan sweep. A generated file this run no longer emits (an object or a package
    // that went away) is removed when it is still exactly what a run wrote. One that was
    // edited by hand is never deleted: it stays, stays recorded, and fails the run by name,
    // as an edited file that is still emitted does. A file the manifest does not record is a
    // stranger and is never touched.
    if !narrowed(opts) {
        let emitted_keys: HashSet<String> = written_hashes
            .keys()
            .cloned()
            .chain(refusal.edited.iter().cloned())
            .collect();
        for (key, recorded) in p.not_emitted(&emitted_keys) {
            let path = p.project_root.join(&key);
            match std::fs::read(&path) {
                Ok(disk) if sha256_hex(&disk) == recorded => {
                    std::fs::remove_file(&path).map_err(|e| io_error("removing", &path, &e))?;
                    remove_empty_parents(&path, &p.out_dir);
                    p.manifest.remove(&key);
                    files.removed += 1;
                    changes.push(Change::new(&key, ChangeKind::Removed));
                }
                Ok(_) => refusal.orphans.push(key),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => p.manifest.remove(&key),
                Err(e) => return Err(io_error("reading", &path, &e)),
            }
        }
    }

    // The manifest is written once, and only when a record changed. It is written even when a
    // file was refused: every record in it is on disk.
    let manifest_written = p
        .manifest
        .save()
        .map_err(|e| io_error("writing", &p.gen_state.join(HASHES_DIR), &e))?;
    if !refusal.is_empty() {
        return Err(RunError::Refused(refusal));
    }

    // Store the key only for a full run, with every generator cacheable.
    if !named && p.cacheable {
        let mut outputs: BTreeMap<String, String> = BTreeMap::new();
        for (key, _) in p.manifest.records() {
            let digest = match written_hashes.get(key) {
                Some(h) => h.clone(),
                None => std::fs::read(p.project_root.join(key))
                    .map(|b| sha256_hex(&b))
                    .unwrap_or_else(|_| ABSENT.to_string()),
            };
            outputs.insert(key.to_string(), digest);
        }
        fingerprint::write_stored(&p.gen_state, &p.key, &outputs)
            .map_err(|e| io_error("writing", &p.gen_state, &e))?;
    }
    p.timings.add_phase(STAGE_WRITE, start.elapsed());

    Ok(RunReport {
        outcome: Outcome::Generated,
        timings: p.timings,
        load_timings,
        files,
        changes,
        out_rel: p.out_rel,
        manifest_written,
        no_skip_reason,
        warnings: p.warnings,
        project_root: p.project_root,
    })
}

/// A generated file `verify` found on disk that no generator emits any more.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtraFile {
    pub path: String,
    /// It no longer has the bytes a run wrote, so `gen` will refuse to delete it.
    pub edited: bool,
}

/// What `verify` found. Nothing was written to get it.
#[derive(Debug, Clone)]
pub struct VerifyReport {
    /// False when the answer came from the stored key and the manifest alone (a local run
    /// with nothing changed since the last `gen`); true when the generators ran.
    pub rendered: bool,
    /// How many generated files were compared (recorded files, when nothing was rendered).
    pub checked: usize,
    /// Files whose bytes on disk differ from a fresh render.
    pub drifted: Vec<String>,
    /// Files a fresh render emits that are not on disk.
    pub missing: Vec<String>,
    /// Recorded files no generator emits any more. Never reported for a narrowed run.
    pub extra: Vec<ExtraFile>,
    pub timings: LoadTimings,
    pub warnings: Vec<String>,
    pub project_root: PathBuf,
    /// The business-rules gate (ADR-0066) over the loaded model. It does not depend on
    /// generated files, so it is part of every `verify`, rendered or not.
    pub rules: RulesCheckResult,
}

impl VerifyReport {
    /// Whether the generated files match the model. The rules gate is separate: see
    /// [`VerifyReport::rules_failed`].
    pub fn in_sync(&self) -> bool {
        self.drifted.is_empty() && self.missing.is_empty() && self.extra.is_empty()
    }

    /// Whether the rules gate has an error-severity finding (a warning never fails a run).
    pub fn rules_failed(&self) -> bool {
        self.rules.errors().next().is_some()
    }
}

/// Compare what the generators would write with what is on disk, in memory. Nothing is
/// written: no file, no manifest, no stored key, no temporary tree.
///
/// `opts.force` is `verify --full`: render even when the stored key says nothing changed.
/// The caller sets it when `CI` is set, so a build server always renders (ADR-0064).
pub fn verify(
    opts: &RunOptions,
    generators: &[Box<dyn Generator>],
) -> Result<VerifyReport, RunError> {
    let mut p = prepare(opts, generators)?;

    if !opts.force && !narrowed(opts) && p.cacheable {
        let start = Instant::now();
        let unchanged = p.unchanged_since_last_run();
        p.timings.add_phase(STAGE_SKIP, start.elapsed());
        if unchanged {
            let prefix = format!("{}/", p.out_rel);
            let checked = p
                .manifest
                .records()
                .filter(|(k, _)| k.starts_with(&prefix))
                .count();
            return Ok(VerifyReport {
                rendered: false,
                checked,
                drifted: Vec::new(),
                missing: Vec::new(),
                extra: Vec::new(),
                timings: p.timings,
                rules: rules_of(&p.loaded),
                warnings: p.warnings,
                project_root: p.project_root,
            });
        }
    }

    let emitted = render(&mut p, opts)?;
    let start = Instant::now();
    let mut drifted = Vec::new();
    let mut missing = Vec::new();
    let mut emitted_keys: HashSet<String> = HashSet::with_capacity(emitted.len());
    for f in &emitted {
        let key = p.key_of(f);
        let path = p.project_root.join(&key);
        match std::fs::read(&path) {
            Ok(disk) if disk == f.content.as_bytes() => {}
            Ok(_) => drifted.push(key.clone()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => missing.push(key.clone()),
            Err(e) => return Err(io_error("reading", &path, &e)),
        }
        emitted_keys.insert(key);
    }
    // The gate reports exactly what `gen` would sweep, so "regenerate" is always the remedy
    // and can never loop: an unrecorded file is nobody's, and a recorded path already gone
    // from disk is forgotten by the next run without a word.
    let mut extra = Vec::new();
    if !narrowed(opts) {
        for (key, recorded) in p.not_emitted(&emitted_keys) {
            let path = p.project_root.join(&key);
            match std::fs::read(&path) {
                Ok(disk) => extra.push(ExtraFile {
                    edited: sha256_hex(&disk) != recorded,
                    path: key,
                }),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(io_error("reading", &path, &e)),
            }
        }
    }
    p.timings.add_phase(STAGE_COMPARE, start.elapsed());

    Ok(VerifyReport {
        rendered: true,
        checked: emitted.len(),
        drifted,
        missing,
        extra,
        timings: p.timings,
        rules: rules_of(&p.loaded),
        warnings: p.warnings,
        project_root: p.project_root,
    })
}

/// The rules gate over a loaded project, under the project's own `rules.*` settings.
fn rules_of(loaded: &LoadedProject) -> RulesCheckResult {
    let result = &loaded.result;
    let objects = ObjectIndex::build(&result.tree, result.root);
    check_rules(
        &result.tree,
        result.root,
        &objects,
        &loaded.collection.config.rules,
    )
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
