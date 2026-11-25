//! Overridable parts (ADR-0063 item 7): a generator of your own implements a shipped
//! generator's `*Parts` trait, overrides one piece, and every other file it writes is the
//! shipped generator's, byte for byte.

mod common;

use std::collections::BTreeMap;
use std::path::PathBuf;

use common::{Scratch, shop_files};
use metaobjects_codegen::client::{self, ClientParts};
use metaobjects_codegen::entity::{self, EntityParts};
use metaobjects_codegen::plan::CratePlan;
use metaobjects_codegen::{
    ClientGenerator, EmittedFile, EntityGenerator, GenContext, GenError, Generator, RunOptions, run,
};

const NOTE: &str = "# owned: this crate's manifest is ours";

/// The entity generator with its model crates' manifest changed and nothing else.
struct NotedEntity;

impl EntityParts for NotedEntity {
    fn manifest(&self, name: &str, c: &CratePlan) -> String {
        format!("{}{NOTE}\n", entity::cargo_toml(name, c))
    }
}

impl Generator for NotedEntity {
    fn name(&self) -> &str {
        "entity"
    }
    fn generate(&self, ctx: &GenContext<'_>) -> Result<Vec<EmittedFile>, GenError> {
        self.render(ctx)
    }
}

/// The client generator with its client crates' lib.rs changed and nothing else.
struct NotedClient;

impl ClientParts for NotedClient {
    fn lib_file(&self, package: &str, items: &[(String, Vec<String>)]) -> String {
        format!("{}// ours\n", client::lib_file(package, items))
    }
}

impl Generator for NotedClient {
    fn name(&self) -> &str {
        "client"
    }
    fn generate(&self, ctx: &GenContext<'_>) -> Result<Vec<EmittedFile>, GenError> {
        self.render(ctx)
    }
}

fn generated(tag: &str, generators: Vec<Box<dyn Generator>>) -> BTreeMap<String, String> {
    let p = Scratch::project(tag, &shop_files());
    let mut opts = RunOptions::new(p.path());
    opts.out_dir = PathBuf::from("generated");
    run(&opts, &generators).unwrap_or_else(|e| panic!("gen failed: {e}"));
    let root = p.path().join("generated");
    let mut out = BTreeMap::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).unwrap() {
            let path = e.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let rel = path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(rel, std::fs::read_to_string(&path).unwrap());
            }
        }
    }
    out
}

#[test]
fn overriding_one_piece_changes_that_piece_and_nothing_else() {
    let shipped = generated(
        "parts-shipped",
        vec![Box::new(EntityGenerator), Box::new(ClientGenerator)],
    );
    let owned = generated(
        "parts-owned",
        vec![Box::new(NotedEntity), Box::new(NotedClient)],
    );
    assert_eq!(
        shipped.keys().collect::<Vec<_>>(),
        owned.keys().collect::<Vec<_>>(),
        "the same files"
    );
    let mut manifests = 0;
    let mut libs = 0;
    for (path, text) in &shipped {
        let mine = &owned[path];
        // A model crate is a crate of the entity generator other than its support crate.
        let model_manifest = path.ends_with("/Cargo.toml")
            && !path.starts_with("meta_support/")
            && !path.contains("_client")
            && text.contains("entity generator");
        // A client crate's lib.rs, not the transport crate's (`meta_client`).
        let client_lib =
            path.ends_with("/src/lib.rs") && text.contains("//! A client for the REST API");
        if model_manifest {
            manifests += 1;
            assert_eq!(*mine, format!("{text}{NOTE}\n"), "{path}");
        } else if client_lib {
            libs += 1;
            assert_eq!(*mine, format!("{text}// ours\n"), "{path}");
        } else {
            assert_eq!(mine, text, "{path} is the shipped generator's");
        }
    }
    assert!(
        manifests > 0 && libs > 0,
        "the overridden pieces were written"
    );
}
