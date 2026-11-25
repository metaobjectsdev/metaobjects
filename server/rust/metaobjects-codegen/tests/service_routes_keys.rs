//! The transport over keys that are not `long`, and the route collisions `gen` refuses.
//!
//! The api-contract corpora key every entity by a `long`; this model keys one by text and one
//! by an `int`, so each route reads its key into the type the service takes. The compile gate
//! leaves the transport out (it is opt-in, and no port's gate builds its route tier), so this
//! test lists it and builds it.

mod common;

use std::path::PathBuf;

use common::{Scratch, assert_builds, generated_workspace};
use metaobjects_codegen::generator_list::{GENERATOR_LIST_FILE, scaffold};
use metaobjects_codegen::{RunOptions, run, shipped_generators};

const KEYS: &str = r#"{ "metadata.root": { "package": "keys", "children": [
  { "object.entity": { "name": "Country", "children": [
    { "source.rdb": { "@table": "countries" } },
    { "field.string": { "name": "code", "@maxLength": 2 } },
    { "identity.primary": { "name": "pk", "@fields": ["code"] } },
    { "field.string": { "name": "title", "@required": true } },
    { "field.enum": { "name": "status", "@values": ["open", "closed"], "@default": "open", "children": [
      { "transition.action": { "name": "close", "@from": ["open"], "@to": "closed", "@public": true } }
    ] } }
  ] } },
  { "object.entity": { "name": "Region", "children": [
    { "source.rdb": { "@table": "regions" } },
    { "field.int": { "name": "id" } },
    { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
    { "field.string": { "name": "title", "@required": true } }
  ] } }
] } }"#;

fn project(tag: &str, model: &str) -> Scratch {
    let p = Scratch::project(tag, &[("metaobjects/meta.keys.json", model)]);
    p.write(GENERATOR_LIST_FILE, &scaffold(true));
    p
}

fn gen_run(p: &Scratch) -> Result<(), String> {
    let mut opts = RunOptions::new(p.path());
    opts.out_dir = PathBuf::from("generated");
    run(&opts, &shipped_generators())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[test]
fn text_and_int_keys_build_through_the_transport() {
    let p = project("routes-keys", KEYS);
    gen_run(&p).unwrap_or_else(|e| panic!("gen failed: {e}"));
    let lib = p.read("generated/keys_http/src/lib.rs");
    assert!(
        lib.contains("let id = id.as_str();"),
        "a text key is borrowed:\n{lib}"
    );
    assert!(
        lib.contains("let id: i32 = meta_http::int_key(&id)?;"),
        "an int key is read as an i32:\n{lib}"
    );
    let ws = generated_workspace("routes-keys-ws", &p, None);
    assert_builds(&ws, "the transport over text and int keys");
}

#[test]
fn a_declared_route_over_a_derived_one_is_refused() {
    // An API whose query takes the list route's own path and method.
    let api = r#",
  { "api.operational": { "name": "admin", "children": [
    { "operation.query": { "name": "allCountries", "@outputRef": "Country", "@many": true, "@public": true, "children": [
      { "binding.rest": { "@method": "GET", "@path": "/countries" } }
    ] } }
  ] } }"#;
    let at = KEYS.rfind("\n] } }").expect("the root's close");
    let model = format!("{}{api}{}", &KEYS[..at], &KEYS[at..]);
    let e = gen_run(&project("routes-collide", &model)).unwrap_err();
    assert!(
        e.contains("ERR_NAME_COLLISION") && e.contains("GET /countries"),
        "{e}"
    );
}
