- **Independent packs: the `packs/` directory, its gates and its lane (ADR-0069).** A capability
  that is not core vocabulary can now be built in `packs/<name>/` with its own version, changelog
  and port list, outside the default bundle and outside `metamodelVersion`. No pack is shipped
  yet, and nothing published changes. `scripts/check-pack-boundary.ts` fails a change that makes core
  depend on a pack, puts a pack in the bundle, or lets core's release tooling see `packs/`.
  `scripts/check-pack-manifests.ts` holds each `pack.json` to its ports' native manifests.
  `scripts/pack-vocabulary.ts` pins the rows a pack adds and fails one that changes the bundle's,
  and `scripts/pack-conformance.ts` runs a pack's load fixtures through the new corpus-root entry
  point `runCorpus` in `@metaobjectsdev/conformance`. A new `packs` lane in `ci-local.sh` blocks
  for a pack's own change and reports, without failing, a pack that a core change breaks. The
  root `build` and `typecheck` scripts now name core's workspace directories instead of
  `--filter '*'`. The provider contract is now named as covered by core's package version
  (`docs/compatibility-policy.md`).
