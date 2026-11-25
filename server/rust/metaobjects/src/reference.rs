//! Reference nodes: the top-level nodes only REFERENCE sources declare
//! (`{ "path": …, "reference": true }` in `.metaobjects/config.json`).
//!
//! They load, validate and resolve like any other node, so a prompt's `@responseRef`
//! can name a reply type another run generates; no generator here emits them.
//! Ported from the TypeScript SDK (`memory.ts`, `referenceNodesOf`).

use std::collections::BTreeSet;

use crate::errors::{ERR_REFERENCE_SOURCE_TEMPLATE, MetaError};
use crate::node::{NodeId, Tree};
use crate::validate::prompt::TYPE_TEMPLATE;

/// The resolution keys of the top-level nodes every one of whose declaring files (every
/// overlay contributor included) is in `reference_ids`. One declaration in an ordinary
/// file makes the node the project's own.
///
/// A `template.*` declared only in reference files is refused with
/// `ERR_REFERENCE_SOURCE_TEMPLATE`: a reference source holds shapes another run generates,
/// and nothing here could honour a prompt in one.
pub fn reference_nodes_of(
    tree: &Tree,
    root: NodeId,
    reference_ids: &BTreeSet<String>,
) -> Result<BTreeSet<String>, MetaError> {
    let mut out = BTreeSet::new();
    if reference_ids.is_empty() {
        return Ok(out);
    }
    // ADR-0039 sanctioned own: the metadata root has no super chain, so its own children
    // are its top-level nodes.
    for &id in tree.own_children(root) {
        let node = tree.node(id);
        let files = node.source.files();
        if files.is_empty() || !files.iter().all(|f| reference_ids.contains(f)) {
            continue;
        }
        let key = tree.resolution_key(id);
        if node.type_name == TYPE_TEMPLATE {
            return Err(MetaError::at(
                ERR_REFERENCE_SOURCE_TEMPLATE,
                format!(
                    "template \"{key}\" is declared only in a reference source ({}). A reference source holds shapes another run generates; declare the prompt in one of the project's own sources, where its parser and payload are generated.",
                    files.join(", ")
                ),
                node.source.clone(),
            ));
        }
        out.insert(key);
    }
    Ok(out)
}
