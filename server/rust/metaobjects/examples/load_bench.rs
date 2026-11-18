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
//! cargo run --release --example load_bench [-- <copies> <iterations>]
//! ```

use std::time::{Duration, Instant};

use metaobjects::loader::Loader;
use metaobjects::node::{NodeId, Tree};
use metaobjects::providers::default_registry;
use metaobjects::serializer::canonical_serialize;

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

fn main() {
    let mut args = std::env::args().skip(1);
    let copies: usize = args
        .next()
        .map_or(20, |a| a.parse().expect("copies is a number"));
    let iterations: usize = args
        .next()
        .map_or(15, |a| a.parse().expect("iterations is a number"));
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

    let t = Instant::now();
    let registry = default_registry().expect("the built-in providers compose");
    let compose = t.elapsed();

    let loader = Loader::new(&registry);
    let mut loads = Vec::with_capacity(iterations);
    let mut serializes = Vec::with_capacity(iterations);
    let mut cold_reads = Vec::with_capacity(iterations);
    let mut warm_reads = Vec::with_capacity(iterations);
    let mut nodes = 0;
    for _ in 0..iterations {
        let t = Instant::now();
        let result = loader.load_sources(&sources);
        loads.push(t.elapsed());
        assert!(
            result.errors.is_empty(),
            "the scaled model loads clean: {:?}",
            result.errors.first()
        );
        nodes = result.tree.len();
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
    println!(
        "load (parse, merge, extends, references), median of {iterations}: {:?}",
        median(loads)
    );
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
