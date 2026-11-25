//! `resolve_collection`: the single authority on where a project's metadata
//! lives, ported from the TypeScript SDK's `collection.ts` and `discovery.ts`.
//!
//! `metaobjects/` is the DEFAULT value of `sources`, never a requirement.
//! Dependency snapshots are not resolved here: a config that declares
//! `dependencies` gets them back unresolved in [`Collection::dependencies`].

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::config::{
    ApiPagination, Config, DependencySpec, EnumDefaults, HandEditsPolicy, Scope, UnknownFieldsMode,
    WireFormat, load_config,
};
use crate::errors::{ERR_COLLECTION_NOT_FOUND, ERR_UNKNOWN, ERR_UNKNOWN_LIBRARY, MetaError};
use crate::library::{known_library_tokens, library_sources, unknown_library_tokens};
use crate::naming::{NamingRegistry, PhysicalNaming};
use crate::source::ErrorSource;
use crate::sources::{
    CONFIG_FILE, DEFAULT_METADATA_DIR, DEFAULT_METAOBJECTS_DIR, ResolvedSource, SourceSpec,
    absolutize, default_sources, is_metadata_file, ordered_path_specs, resolve_sources,
    resolve_spec_path,
};

const GIT_DIR: &str = ".git";
/// Bound on the metadata-document sniff used to improve one error message.
const MAX_SNIFFED_FILES: usize = 20;

/// A resolved project: where its config lives, which files it reads and every
/// setting the config declares.
#[derive(Debug, Clone)]
pub struct Collection {
    /// Directory whose config declared this collection (or the resolved start
    /// directory, when nothing was discovered and the default applies).
    pub config_dir: PathBuf,
    /// Canonically ordered absolute metadata file paths. With dependencies
    /// unresolved this equals [`Collection::own_files`].
    pub files: Vec<PathBuf>,
    /// Same set, carrying the contributing spec.
    pub sources: Vec<ResolvedSource>,
    /// The distinct roots the declared specs resolve to, in canonical order.
    pub source_roots: Vec<PathBuf>,
    /// The project's own metadata files.
    pub own_files: Vec<PathBuf>,
    /// The loader ids ([`Collection::read_sources`]) of the REFERENCE files: those only
    /// `{ "path": …, "reference": true }` sources reach. Empty when none is declared.
    pub reference_ids: BTreeSet<String>,
    /// Declared dependencies, validated but NOT resolved against any snapshot.
    pub dependencies: Vec<DependencySpec>,
    /// The shipped-library selection as authored.
    pub libraries: Vec<String>,
    pub physical_naming: PhysicalNaming,
    pub wire_format: WireFormat,
    pub enum_defaults: EnumDefaults,
    pub api_pagination: Option<ApiPagination>,
    pub api_unknown_fields: Option<UnknownFieldsMode>,
    /// `migrate.conventions`.
    pub schema_conventions: Option<String>,
    /// `migrate.checks.skipRedundant`; false when absent.
    pub skip_redundant_checks: bool,
    /// `migrate.foreignKeyIndexes`; false when absent.
    pub foreign_key_indexes: bool,
    /// `verify.handEdits`.
    pub hand_edits: Option<HandEditsPolicy>,
    /// The declared `scope`, parsed (matching is not part of this module).
    pub scope: Option<Scope>,
    /// `migrate.scope` patterns.
    pub migrate_scope: Option<Vec<String>>,
    /// `requirements.inherit` patterns.
    pub requirements_inherit: Option<Vec<String>>,
    /// The whole parsed config; the default config when none was found.
    pub config: Config,
    /// Warnings reading the config produced (unknown top-level keys).
    pub warnings: Vec<String>,
}

impl Collection {
    /// The ordered `(id, text)` pairs the loader should receive: the selected
    /// shipped libraries first (ids like `library:iam/model.yaml`), then the
    /// project's own files (ids are their absolute paths). A file that cannot be
    /// read is returned as an error and the rest are still returned.
    pub fn read_sources(&self) -> (Vec<(String, String)>, Vec<MetaError>) {
        let mut out = library_sources(&self.libraries);
        let mut errors = Vec::new();
        for file in &self.files {
            let id = file.to_string_lossy().into_owned();
            match std::fs::read_to_string(file) {
                Ok(text) => out.push((id, text)),
                Err(e) => errors.push(MetaError::at(
                    ERR_UNKNOWN,
                    format!("{id}: cannot read metadata file: {e}"),
                    ErrorSource::json(&id, "$"),
                )),
            }
        }
        (out, errors)
    }
}

fn exists(p: &Path) -> bool {
    std::fs::metadata(p).is_ok()
}

fn is_dir(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_dir())
}

/// Where the discovery walk stopped, and what it found there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredRoot {
    pub dir: PathBuf,
    /// Whether `dir` carries `.metaobjects/config.json`. False only on the
    /// no-marker fallback, where the default sources apply.
    pub has_config: bool,
}

/// Walk up from `start_dir` for the nearest directory holding
/// `.metaobjects/config.json`, the only project marker. The walk stops after a
/// directory containing `.git`, checked AFTER the marker so a repo-root project
/// stays findable. With no marker it reports the resolved start directory.
pub fn discover_collection_root(start_dir: &Path) -> DiscoveredRoot {
    let start = absolutize(start_dir);
    let mut dir = start.clone();
    loop {
        if exists(&dir.join(DEFAULT_METAOBJECTS_DIR).join(CONFIG_FILE)) {
            return DiscoveredRoot {
                dir,
                has_config: true,
            };
        }
        if exists(&dir.join(GIT_DIR)) {
            break;
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => break,
        }
    }
    DiscoveredRoot {
        dir: start,
        has_config: false,
    }
}

/// The directory whose configuration governs a run started in `start_dir`.
pub fn resolve_config_dir(start_dir: &Path) -> PathBuf {
    discover_collection_root(start_dir).dir
}

/// A cheap "is this file a metadata DOCUMENT?" sniff, for a diagnostic only.
fn sniffs_as_metadata_document(file: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(file) else {
        return false;
    };
    let is_json = file
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("json"));
    if !is_json {
        return text.lines().any(|l| {
            l.strip_prefix("metadata")
                .is_some_and(|r| r.trim_start().starts_with(':'))
        });
    }
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .is_some_and(|v| {
            v.as_object()
                .is_some_and(|o| o.contains_key("metadata.root"))
        })
}

/// Does `dir` hold metadata but carry no project marker: is it the METADATA
/// directory, handed to a command whose argument is the PROJECT ROOT?
fn holds_metadata_but_is_no_root(dir: &Path, has_config: bool) -> bool {
    if has_config {
        return false;
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return false;
    };
    let mut names: Vec<String> = read
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| is_metadata_file(n))
        .collect();
    names.sort();
    names
        .iter()
        .take(MAX_SNIFFED_FILES)
        .any(|n| sniffs_as_metadata_document(&dir.join(n)))
}

/// THE single authority on where metadata lives.
///
/// An `explicit_dir` wins outright; otherwise discovery walks up from
/// `start_dir`. A config that EXISTS but is invalid is the author's error and
/// propagates. Only an absent config falls through to the default `metaobjects`
/// directory, and `ERR_COLLECTION_NOT_FOUND` is raised only when no sources were
/// declared AND that default does not exist. A declared source that does not
/// resolve is `ERR_SOURCE_UNRESOLVED`.
pub fn resolve_collection(
    start_dir: &Path,
    explicit_dir: Option<&Path>,
    naming: &NamingRegistry,
) -> Result<Collection, MetaError> {
    let (config_dir, has_config) = match explicit_dir {
        Some(dir) => {
            let dir = absolutize(dir);
            let has = exists(&dir.join(DEFAULT_METAOBJECTS_DIR).join(CONFIG_FILE));
            (dir, has)
        }
        None => {
            let found = discover_collection_root(start_dir);
            (found.dir, found.has_config)
        }
    };

    let mut config = Config::default();
    let mut warnings = Vec::new();
    if has_config {
        let loaded = load_config(&config_dir.join(DEFAULT_METAOBJECTS_DIR), naming)?;
        config = loaded.config;
        warnings = loaded.warnings;
        // A token a human typed into a config is a mistake worth failing on.
        let unknown = unknown_library_tokens(&config.libraries);
        if !unknown.is_empty() {
            let quoted = |v: &[String]| {
                let items: Vec<String> = v.iter().map(|s| format!("\"{s}\"")).collect();
                format!("[{}]", items.join(","))
            };
            return Err(MetaError::code(
                ERR_UNKNOWN_LIBRARY,
                format!(
                    ".metaobjects/config.json in {}: 'libraries' names unknown librar{} {}; available: {}.",
                    config_dir.display(),
                    if unknown.len() == 1 { "y" } else { "ies" },
                    quoted(&unknown),
                    quoted(&known_library_tokens()),
                ),
            ));
        }
    }

    let using_default = config.sources.is_empty();
    let specs: Vec<SourceSpec> = if using_default {
        default_sources()
    } else {
        config.sources.clone()
    };

    if using_default && !is_dir(&config_dir.join(DEFAULT_METADATA_DIR)) {
        if holds_metadata_but_is_no_root(&config_dir, has_config) {
            let parent = config_dir.parent().unwrap_or(&config_dir).to_path_buf();
            let near = discover_collection_root(&parent);
            let suggested = if near.has_config { near.dir } else { parent };
            return Err(MetaError::code(
                ERR_COLLECTION_NOT_FOUND,
                format!(
                    "{} looks like a metadata directory, not a project root — it holds metadata files but carries no {DEFAULT_METAOBJECTS_DIR}/{CONFIG_FILE}. A directory argument here is the PROJECT ROOT that CONTAINS your metadata; where the metadata lives is then the root's \"sources\" (default: the \"{DEFAULT_METADATA_DIR}\" directory beneath it). Try {} instead.",
                    config_dir.display(),
                    suggested.display()
                ),
            ));
        }
        return Err(MetaError::code(
            ERR_COLLECTION_NOT_FOUND,
            format!(
                "no metadata sources declared in {} and no default \"{DEFAULT_METADATA_DIR}\" directory found. Declare \"sources\" in {DEFAULT_METAOBJECTS_DIR}/{CONFIG_FILE} — each entry is an OBJECT, e.g. \"sources\": [{{ \"path\": \"model\" }}] — or run 'meta init' to scaffold.",
                config_dir.display()
            ),
        ));
    }

    let own_sources = resolve_sources(&config_dir, &specs)?;
    let own_files: Vec<PathBuf> = own_sources.iter().map(|s| s.file.clone()).collect();

    let mut source_roots: Vec<PathBuf> = Vec::new();
    for (path, _) in ordered_path_specs(&specs)? {
        let root = resolve_spec_path(&config_dir, &path);
        if !source_roots.contains(&root) {
            source_roots.push(root);
        }
    }

    let reference_ids: BTreeSet<String> = own_sources
        .iter()
        .filter(|s| s.reference)
        .map(|s| s.file.to_string_lossy().into_owned())
        .collect();

    let migrate = config.migrate.clone();
    Ok(Collection {
        config_dir,
        reference_ids,
        files: own_files.clone(),
        own_files,
        sources: own_sources,
        source_roots,
        dependencies: config.dependencies.clone(),
        libraries: config.libraries.clone(),
        physical_naming: config.physical_naming(),
        wire_format: config.wire_format(),
        enum_defaults: config.enum_defaults(),
        api_pagination: config.api_pagination(),
        api_unknown_fields: config.api_unknown_fields(),
        schema_conventions: migrate.as_ref().and_then(|m| m.conventions.clone()),
        skip_redundant_checks: migrate
            .as_ref()
            .is_some_and(|m| m.checks_skip_redundant == Some(true)),
        foreign_key_indexes: migrate
            .as_ref()
            .is_some_and(|m| m.foreign_key_indexes == Some(true)),
        hand_edits: config.hand_edits,
        scope: config.scope.clone(),
        migrate_scope: migrate.and_then(|m| m.scope),
        requirements_inherit: config.requirements_inherit.clone(),
        config,
        warnings,
    })
}
