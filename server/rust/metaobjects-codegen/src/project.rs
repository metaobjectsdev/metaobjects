//! Reading a project the way the other ports read it: find its collection, read its
//! config, gather its files (YAML and JSON, plus the opted-in libraries), and load them.

use std::path::Path;

use metaobjects::collection::{Collection, resolve_collection};
use metaobjects::errors::MetaError;
use metaobjects::loader::{LoadResult, Loader};
use metaobjects::naming::NamingRegistry;
use metaobjects::providers::default_registry;

/// A loaded project: the resolved collection and the model it loaded.
#[derive(Debug)]
pub struct LoadedProject {
    pub collection: Collection,
    pub result: LoadResult,
}

/// Resolve and load the project that `start_dir` belongs to (or `explicit_dir`, when given).
/// Every load error (and every unreadable file) comes back together; the model is only
/// returned when there are none.
pub fn load_project(
    start_dir: &Path,
    explicit_dir: Option<&Path>,
    strict: bool,
) -> Result<LoadedProject, Vec<MetaError>> {
    let naming = NamingRegistry::builtin();
    let collection = resolve_collection(start_dir, explicit_dir, &naming).map_err(|e| vec![e])?;
    let (sources, mut read_errors) = collection.read_sources();
    let mut registry = default_registry().map_err(|e| vec![e])?;
    registry.seal();
    let mut result = Loader::new(&registry)
        .naming(naming, collection.physical_naming.clone())
        .strict(strict)
        .load_sources(&sources);
    read_errors.append(&mut result.errors);
    if !read_errors.is_empty() {
        return Err(read_errors);
    }
    Ok(LoadedProject { collection, result })
}
