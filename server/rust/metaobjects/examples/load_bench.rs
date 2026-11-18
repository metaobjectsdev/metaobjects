//! Load-time benchmark on a 20-times model built in memory from the public
//! conformance fitness model (`fixtures/persistence-conformance/canonical/meta.fitness.json`).
//!
//! Each copy keeps every name and gets its own root package (`fitness_x00` ...
//! `fitness_x19`), so the copies never collide and every bare reference still
//! resolves inside its own copy. Nothing is written to disk.
//!
//! Run it in release mode:
//!
//! ```text
//! cargo run --release --example load_bench [-- <copies> <iterations> [json|yaml|project|all]]
//! ```
//!
//! `json`, `yaml` and `project` run one part only, so a peak-memory reading (for example
//! `/usr/bin/time -f %M`) belongs to that format alone. `all` is the default.

use std::time::{Duration, Instant};

use metaobjects::collection::resolve_collection;
use metaobjects::loader::Loader;
use metaobjects::naming::NamingRegistry;
use metaobjects::node::{NodeId, Tree};
use metaobjects::providers::default_registry;
use metaobjects::serializer::canonical_serialize;
use metaobjects::yaml::parse_yaml;
use serde_json::Value;

const FITNESS: &str =
    include_str!("../../../../fixtures/persistence-conformance/canonical/meta.fitness.json");
const ROOT_PACKAGE: &str = "\"package\": \"fitness\"";

fn median(mut v: Vec<Duration>) -> Duration {
    v.sort();
    v[v.len() / 2]
}

/// One pass of every memoized resolving read over every node: the read path a
/// runtime caller exercises. The first pass on a frozen tree fills the caches.
fn read_pass(tree: &Tree) -> usize {
    let mut n = 0;
    for i in 0..tree.len() {
        let id = NodeId::from_index(i);
        n += tree.children(id).len() + tree.attrs(id).len();
        n += usize::from(tree.resolved_is_array(id));
    }
    n
}

/// A canonical node as sigil-free authoring YAML (ADR-0006): attributes lose
/// their `@`, and the fused `type.subType` key stays. `prefix` is the text before
/// the key on its first line (`"- "` for a list item), which also sets the
/// column the body lines up under.
fn emit_node(out: &mut String, prefix: &str, node: &Value) {
    let (key, body) = node
        .as_object()
        .and_then(|m| m.iter().next())
        .expect("a node is a one-key wrapper");
    out.push_str(&format!("{prefix}{key}:\n"));
    let pad = " ".repeat(prefix.len() + 2);
    for (k, v) in body.as_object().expect("a node body is a mapping") {
        if k == "children" {
            out.push_str(&format!("{pad}children:\n"));
            for child in v.as_array().expect("children is a list") {
                emit_node(out, &format!("{pad}  - "), child);
            }
        } else {
            let k = k.strip_prefix('@').unwrap_or(k);
            // A JSON value is a YAML flow value.
            out.push_str(&format!("{pad}{k}: {v}\n"));
        }
    }
}

fn to_yaml(json: &str) -> String {
    let doc: Value = serde_json::from_str(json).expect("the model is JSON");
    let mut out = String::new();
    emit_node(&mut out, "", &doc);
    out
}

/// The project-reading steps, each timed on its own: read the config, walk the
/// metadata directory, and read every file's text. The model is written to a
/// scratch directory (`$DEV_SCRATCH`, a RAM disk) and removed afterwards.
fn project_rows(sources: &[(String, String)], iterations: usize) {
    let base = std::env::var_os("DEV_SCRATCH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join(format!("mo-load-bench-{}", std::process::id()));
    std::fs::create_dir_all(dir.join(".metaobjects")).expect("scratch dir");
    std::fs::create_dir_all(dir.join("metaobjects")).expect("scratch dir");
    std::fs::write(
        dir.join(".metaobjects/config.json"),
        r#"{ "schema_version": 1, "naming": { "columns": "snake_case" }, "libraries": ["iam", "ai"] }"#,
    )
    .expect("config");
    for (id, text) in sources {
        std::fs::write(dir.join("metaobjects").join(id), text).expect("model file");
    }
    let naming = NamingRegistry::builtin();
    let (mut resolves, mut reads) = (Vec::new(), Vec::new());
    for _ in 0..iterations {
        let t = Instant::now();
        let collection = resolve_collection(&dir, None, &naming).expect("the project resolves");
        resolves.push(t.elapsed());
        let t = Instant::now();
        let (pairs, errors) = collection.read_sources();
        reads.push(t.elapsed());
        assert!(errors.is_empty(), "{errors:?}");
        std::hint::black_box(pairs);
    }
    let _ = std::fs::remove_dir_all(&dir);
    println!(
        "project: config read + directory walk ({} files), median of {iterations}: {:?}",
        sources.len(),
        median(resolves)
    );
    println!(
        "project: read every file's text plus the library sources, median of {iterations}: {:?}",
        median(reads)
    );
}

fn main() {
    let mut args = std::env::args().skip(1);
    let copies: usize = args
        .next()
        .map_or(20, |a| a.parse().expect("copies is a number"));
    let iterations: usize = args
        .next()
        .map_or(15, |a| a.parse().expect("iterations is a number"));
    let mode = args.next().unwrap_or_else(|| "all".to_string());
    let (do_json, do_yaml, do_project) = match mode.as_str() {
        "json" => (true, false, false),
        "yaml" => (false, true, false),
        "project" => (false, false, true),
        "all" => (true, true, true),
        other => panic!("mode is json, yaml, project or all, not {other}"),
    };
    assert!(
        FITNESS.contains(ROOT_PACKAGE),
        "the fitness model declares its root package"
    );
    let sources: Vec<(String, String)> = (0..copies)
        .map(|i| {
            let text = FITNESS.replacen(
                ROOT_PACKAGE,
                &format!("\"package\": \"fitness_x{i:02}\""),
                1,
            );
            (format!("meta.fitness_x{i:02}.json"), text)
        })
        .collect();
    let bytes: usize = sources.iter().map(|(_, t)| t.len()).sum();
    let yaml_sources: Vec<(String, String)> = if do_yaml {
        sources
            .iter()
            .map(|(id, text)| (id.replace(".json", ".yaml"), to_yaml(text)))
            .collect()
    } else {
        Vec::new()
    };
    let yaml_bytes: usize = yaml_sources.iter().map(|(_, t)| t.len()).sum();

    if do_project {
        project_rows(&sources, iterations);
        if !do_json && !do_yaml {
            return;
        }
    }

    let t = Instant::now();
    let registry = default_registry().expect("the built-in providers compose");
    let compose = t.elapsed();

    let loader = Loader::new(&registry);
    let mut loads = Vec::with_capacity(iterations);
    let mut yaml_loads = Vec::with_capacity(iterations);
    let mut yaml_desugars = Vec::with_capacity(iterations);
    let mut serializes = Vec::with_capacity(iterations);
    let mut cold_reads = Vec::with_capacity(iterations);
    let mut warm_reads = Vec::with_capacity(iterations);
    let mut nodes = 0;
    for _ in 0..iterations {
        let mut loaded = None;
        if do_json {
            let t = Instant::now();
            let result = loader.load_sources(&sources);
            loads.push(t.elapsed());
            assert!(
                result.errors.is_empty(),
                "the scaled model loads clean: {:?}",
                result.errors.first()
            );
            nodes = result.tree.len();
            loaded = Some(result);
        }
        if do_yaml {
            let t = Instant::now();
            for (id, text) in &yaml_sources {
                std::hint::black_box(parse_yaml(text, &registry, id).expect("the YAML parses"));
            }
            yaml_desugars.push(t.elapsed());
            let t = Instant::now();
            let yaml_result = loader.load_sources(&yaml_sources);
            yaml_loads.push(t.elapsed());
            assert!(
                yaml_result.errors.is_empty(),
                "the YAML model loads clean: {:?}",
                yaml_result.errors.first()
            );
            if do_json {
                assert_eq!(
                    yaml_result.tree.len(),
                    nodes,
                    "YAML and JSON load the same nodes"
                );
            } else {
                nodes = yaml_result.tree.len();
            }
            loaded.get_or_insert(yaml_result);
        }
        let result = loaded.expect("one format ran");
        let t = Instant::now();
        std::hint::black_box(read_pass(&result.tree));
        cold_reads.push(t.elapsed());
        let t = Instant::now();
        std::hint::black_box(read_pass(&result.tree));
        warm_reads.push(t.elapsed());
        let t = Instant::now();
        let out = canonical_serialize(&result.tree, result.root);
        serializes.push(t.elapsed());
        std::hint::black_box(out);
    }
    println!(
        "model: {copies} copies of the fitness model, {} KiB of JSON, {nodes} nodes",
        bytes / 1024
    );
    println!("registry compose: {compose:?}");
    if do_json {
        println!(
            "load (parse, merge, extends, references), median of {iterations}: {:?}",
            median(loads)
        );
    }
    if do_yaml {
        println!(
            "YAML ({} KiB): parse and desugar only, median of {iterations}: {:?}",
            yaml_bytes / 1024,
            median(yaml_desugars)
        );
        println!(
            "YAML load (parse, desugar, merge, extends, references), median of {iterations}: {:?}",
            median(yaml_loads)
        );
    }
    println!(
        "resolved reads of every node (children, attrs, is_array), first pass fills the cache, median of {iterations}: {:?}",
        median(cold_reads)
    );
    println!(
        "resolved reads of every node, from the cache, median of {iterations}: {:?}",
        median(warm_reads)
    );
    println!(
        "canonical serialize, median of {iterations}: {:?}",
        median(serializes)
    );
}
