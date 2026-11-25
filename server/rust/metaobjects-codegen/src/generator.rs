//! The generator contract: what a generator is handed, what it returns, and how it fails.
//!
//! A generator is a pure function of the loaded model: it returns the files it wants on
//! disk and writes nothing itself. The run engine owns reading and writing, so a file whose
//! bytes did not change is never rewritten and the manifest is saved once per run.

use std::collections::BTreeSet;
use std::fmt;

use metaobjects::collection::Collection;
use metaobjects::node::{NodeId, Tree};

/// One generated file: its path relative to the output directory (always `/`-separated)
/// and its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmittedFile {
    pub path: String,
    pub content: String,
}

impl EmittedFile {
    pub fn new(path: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            content: content.into(),
        }
    }
}

/// What a generator reads: the loaded model, the project's settings and the run's entity
/// selection.
#[derive(Debug, Clone, Copy)]
pub struct GenContext<'a> {
    pub tree: &'a Tree,
    pub root: NodeId,
    /// Object names the run was limited to (`cargo meta gen A B`); empty means every object.
    pub entities: &'a [String],
    /// The resolved project: its naming and wire settings (`.metaobjects/config.json`).
    pub collection: &'a Collection,
    /// Resolution keys of the nodes only reference sources declare (computed once at load).
    pub reference_nodes: &'a BTreeSet<String>,
}

/// A generator failed: a shared-style error code and a message for people.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenError {
    pub code: &'static str,
    pub message: String,
}

impl GenError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<crate::writer::WriterError> for GenError {
    fn from(e: crate::writer::WriterError) -> Self {
        Self {
            code: e.code,
            message: e.message,
        }
    }
}

impl fmt::Display for GenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for GenError {}

/// Two types in one crate would take the same Rust name (or module name).
pub const ERR_NAME_COLLISION: &str = "ERR_NAME_COLLISION";
/// Two generators (or two objects) claim one output path.
pub const ERR_PATH_COLLISION: &str = "ERR_PATH_COLLISION";
/// A field or reference the generator cannot turn into Rust.
pub const ERR_UNSUPPORTED: &str = "ERR_RUST_UNSUPPORTED";
/// Crate dependencies between packages form a cycle, which Cargo refuses.
pub const ERR_CRATE_CYCLE: &str = "ERR_CRATE_CYCLE";
/// The output directory is not inside the project.
pub const ERR_OUT_DIR: &str = "ERR_OUT_DIR_OUTSIDE_PROJECT";
/// A project gave a generator an option it does not take.
pub const ERR_UNKNOWN_OPTION: &str = "ERR_UNKNOWN_GENERATOR_OPTION";

/// The options a project wrote for one generator in `metaobjects.config.json`.
pub type Options = serde_json::Map<String, serde_json::Value>;

/// The refusal for options `generator` does not take, naming each one and what it takes
/// (`known`, empty for a generator that takes none). A generator's
/// [`Generator::configure`] returns it for any key outside `known`.
pub fn unknown_options(generator: &str, options: &Options, known: &[&str]) -> GenError {
    let unknown: Vec<String> = options
        .keys()
        .filter(|k| !known.contains(&k.as_str()))
        .map(|k| format!("\"{k}\""))
        .collect();
    let takes = if known.is_empty() {
        "it takes no options".to_string()
    } else {
        format!("it takes: {}", known.join(", "))
    };
    GenError::new(
        ERR_UNKNOWN_OPTION,
        format!(
            "the generator {generator} has no option {}; {takes}",
            unknown.join(", ")
        ),
    )
}

/// A code generator the run engine can drive.
pub trait Generator {
    /// The name `--generators` selects it by.
    fn name(&self) -> &str;

    /// Everything about this generator's own code and options that can change what it
    /// emits. The engine already hashes its own built sources; a generator adds the options
    /// it was constructed with.
    fn identity(&self) -> String {
        self.name().to_string()
    }

    /// Whether a run that includes this generator may be skipped. A generator that reads
    /// anything it cannot declare in [`Generator::extra_inputs`] returns `false`, and a run
    /// that includes it never skips (ADR-0064 section 3).
    fn cacheable(&self) -> bool {
        true
    }

    /// Project-relative paths of files this generator reads besides the model (a directory
    /// is hashed whole). Their content is part of the skip key.
    fn extra_inputs(&self) -> Vec<String> {
        Vec::new()
    }

    /// This generator built with the options a project wrote for it in
    /// `metaobjects.config.json` (`{"name": "client", "options": {...}}`). Options go through a
    /// generator's constructor: a generator that takes options overrides this to construct
    /// itself from them, and refuses any key it does not know with [`unknown_options`]. The
    /// default takes none and refuses every key, so a misspelt option fails the run instead
    /// of being ignored. The engine calls it only for an entry that has options, and the
    /// generator it returns runs in this one's place (its [`Generator::identity`] should
    /// carry the options, since they can change what it emits).
    fn configure(&self, options: &Options) -> Result<Box<dyn Generator>, GenError> {
        Err(unknown_options(self.name(), options, &[]))
    }

    /// Produce the generator's files for the loaded model.
    fn generate(&self, ctx: &GenContext<'_>) -> Result<Vec<EmittedFile>, GenError>;
}
