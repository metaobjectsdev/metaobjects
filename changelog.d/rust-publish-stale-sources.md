- **CI: the Rust publish dry-run no longer verifies against stale source.** `cargo publish
  --workspace` unpacks the crates it depends on from its temporary overlay registry into a
  directory fixed per checkout, and never unpacks them again while the version is unchanged, so a
  machine that had run the gate before a new module landed compiled the old `metaobjects-1.3.0`
  and failed with "could not find `metamodel_docs`". The gate now first clears unpacked copies of
  the workspace's own crates that differ from the tree
  (`scripts/rust-clear-stale-publish-sources.sh`).
