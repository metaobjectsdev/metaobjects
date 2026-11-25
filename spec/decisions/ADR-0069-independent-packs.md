# ADR-0069: Independent packs live in `packs/`, version themselves, and core never depends on them

## Status

**Accepted** (2026-11-24). Registers no vocabulary: `metamodelVersion` is unchanged, and so is
every core package version. It changes what `metamodelVersion` and core's package version promise,
and how a capability that is not yet core is built, tested and released in this repository.

## Context

Since ADR-0050 and the 1.3.0 work, vocabulary beyond the base metamodel lives in **packs**: a
provider of its own, composed into the default bundle and individually removable (`db`,
`documentation`, `prompt`, `ui`, `ui-web`, `rules`, `view-expressions`, `reporting`,
`requirements`). Every one of them is part of core's contract. Its types are in
`fixtures/registry-conformance/expected-registry.json`, which all five ports byte-match. A change
to it moves `metamodelVersion`, and since that manifest forces every registry to publish
(`docs/RELEASING.md`), it ships only in a coordinated core release. Its generators land in
`codegen-ts` and its runtime in `runtime-ts`, so it releases in the 13-package npm lockstep and
writes to the root changelog.

That is the right home for vocabulary core owns. It is the wrong one for a new capability that is
still finding its shape. The rules pack shows the cost: its generator and runtime work went into
core packages and could only ship with a full core release. The next capabilities (system and
delivery vocabulary, deployment generators, UI and agent packs) would pay the same cost, and every
one of their changes would also be a change to core. Core needs to stabilise while those move at
their own pace. The captain's direction for this ADR: build and version them as if they were
separate repositories, while keeping them in this monorepo.

`docs/1.0-readiness.md` already states the principle this ADR builds on: providers added
downstream are outside the metamodel promise (ADR-0023) and do not change `metamodelVersion`, and
an application may version its own providers. An independent pack is a downstream provider that is
maintained in this repository.

## Decision

### 1. Two kinds of pack

| | Bundled pack | Independent pack |
|---|---|---|
| Examples | `db`, `documentation`, `prompt`, `ui`, `ui-web`, `rules`, `view-expressions`, `reporting`, `requirements` | the first one is planned; none exists yet |
| In the default bundle | Yes | No. A project opts in by naming the provider |
| In `expected-registry.json` | Yes | Never |
| Moves `metamodelVersion` | Yes | Never |
| Version | Core's | Its own, in `pack.json` |
| Released | With core | On its own |
| Ports | All (a lagging port still registers the vocabulary) | Those its `pack.json` lists |
| Lives in | Each port's core package | `packs/<name>/` |

**Metamodel N.M names the default bundle only.** An independent pack is outside it, carries its
own version, and may be carried by some ports and not others.

### 2. One direction of dependency

A pack may depend on core and on other packs. **Core never depends on a pack**: no manifest,
import or build file outside `packs/` names a pack package or a `packs/` path, no pack's provider
id is in any port's default provider list or in `fixtures/registry-conformance/`, and no type a
pack declares appears in `expected-registry.json`. Core's release tooling (the npm publish set
and its two gates) does not enumerate `packs/`. `scripts/check-pack-boundary.ts`, in the `gates`
lane, holds all of this. It holds the release-tooling clause by planting pack packages beside a
scratch copy of core's release manifests and asserting that no release gate sees them. So the
property is tested, not true by accident of how two directories are listed today.

The same direction applies to libraries. A library layer that needs an independent pack ships
with that pack, never in `library/`, because core's embedded libraries may not require a provider
core does not carry.

### 3. Layout and manifest

```
packs/<name>/
  pack.json             id, version, stability, what it requires, which ports carry it
  CHANGELOG.md          this pack's changelog (never the root CHANGELOG.md)
  README.md
  metamodel/*.json      the vocabulary definition, in the spec/metamodel/ format
  fixtures/
    expected-vocabulary.json   the rows this pack adds to the default bundle
    conformance/<scenario>/    load fixtures, in the shared fixture format
  typescript/           the npm package
  java/ kotlin/ python/ csharp/ rust/   present only for the ports pack.json lists
```

```json
{
  "id": "metaobjects-<name>",
  "version": "0.1.0",
  "stability": "preview",
  "requires": { "metamodel": ">=1.3 <2", "packs": {} },
  "ports": {
    "typescript": { "package": "@metaobjectsdev/pack-<name>", "core": ">=1.3.0 <2.0.0", "publish": false }
  }
}
```

The pack is the unit of ownership: one directory, one lane-map row, one changelog, and
`git subtree split --prefix packs/<name>` lifts it out with its history if it ever leaves.
`scripts/check-pack-manifests.ts`, in the `gates` lane, checks that each `pack.json` is well formed
(provider id, `X.Y.Z` version, stability word, ranges with an upper bound, required packs that
exist, a port directory for exactly the listed ports, README and changelog). It also checks that
`pack.json` agrees with each port's native manifest, which is what an installer actually reads.

### 4. Names, versions and ranges

- **Names.** npm `@metaobjectsdev/pack-<name>`; Maven `com.metaobjects.packs:<name>`; PyPI
  `metaobjects-pack-<name>` (import name `metaobjects_pack_<name>`); NuGet
  `MetaObjects.Packs.<Name>`; provider id `metaobjects-<name>`. A Kotlin artifact shares the Maven
  namespace as `com.metaobjects.packs:<name>-<suffix>`. The first Kotlin pack names the suffix.
- **Versions.** One version per pack, the same in every port that carries it. A port's artifact
  publishes when it has a changed file and takes the pack's current version, which is core's
  convergent-publishing rule applied inside the pack. Every pack starts at **`0.1.0`, `preview`**
  (`docs/features/stability-labels.md`). Maven takes **no `+7` offset** for packs: a new
  coordinate has no 7.x history to stay ahead of. A break in the pack's vocabulary, or in what a
  project must write to use the pack, is a major (a minor while `0.x`). Added vocabulary is a
  minor, and a change to generator output is a patch.
- **Ranges.** `requires.metamodel` states the metadata contract the pack's vocabulary is written
  against. Each port's own manifest states the core range an installer enforces: npm as a
  **peer** dependency on `@metaobjectsdev/metadata` (never a dependency, so a project never gets
  a second copy of the metamodel classes, the `instanceof` hazard `AGENTS.md` describes), plus a
  `workspace:*` dev dependency so the pack builds against core's working tree. Maven uses a
  `provided`-scope dependency on the floor version, NuGet `[1.3.0,2.0.0)`, PyPI
  `metaobjects>=1.3,<2`, and crates.io the same range once core crates are published at all
  (ADR-0065).

### 5. The provider contract is covered by core's package version

A range like `>=1.3.0 <2.0.0` means something only if what a pack is built on is promised. The
**provider contract** (a provider's `id`, `dependencies` and `registerTypes`; the registry's
`register`, `extend` and `registerCommonAttrs`; and the provider definition file format) is
therefore part of what core's package version promises, beside the CLI and the `Generator`
interface (`docs/compatibility-policy.md`). Breaking it is a core package major.

### 6. Conformance per pack, and the port rule for independent packs

A pack's tests live in the pack, outside `fixtures/`, so the gated corpus counts in `AGENTS.md`
and `docs/CONFORMANCE.md` never move for pack work.

- **Pinned vocabulary.** `packs/<name>/fixtures/expected-vocabulary.json` is the
  registry-conformance pattern scoped to one pack: the rows this pack (with the packs it requires
  already composed) adds to the default bundle, and only those. `scripts/pack-vocabulary.ts`
  derives it in TypeScript, the reference emitter, and every port that carries the pack
  byte-matches it.
- **Leaves core alone.** The same script composes the bundle with and without the pack and fails
  if any row of the bundle's own manifest changes or disappears. A pack may add types, add
  optional attributes and child rules to bundle types (ADR-0050), and add common attributes. It
  may not change anything the bundle declares. This is ADR-0050's composition invariant pointed
  outward.
- **Load fixtures.** `packs/<name>/fixtures/conformance/<scenario>/` uses the shared fixture
  format, and each scenario's `providers.json` must name the pack, because a scenario that loads
  only the bundle tests core. TypeScript runs them with `runCorpus` (`@metaobjectsdev/conformance`,
  the corpus-root entry point) through the same adapter as `fixtures/conformance/`, composed with
  the pack's provider (`scripts/pack-conformance.ts`). Another port gets the same entry point
  when a pack first ships there.
- **The port rule.** The bundle rule is unchanged: a lagging port still registers the bundle's
  vocabulary and loads it strictly. **For an independent pack, a port either carries the provider
  and passes the pack's whole corpus, or does not carry it, and a model that uses the pack fails
  there with an error naming what it does not know.** This is the one place the design departs
  from "every port, every type", and it applies to independent packs only.

### 7. CI: a lane of its own, and a canary on core changes

`packs` is a lane in `scripts/ci-local.sh`. It runs on every pull request in the hosted
TypeScript job (`.github/workflows/pr-ci.yml`), and on every push to `main` in its own job in
`.github/workflows/local-ci.yml`, which is in the known-green lane map
(`scripts/ci-ports-to-run.sh`) like every other lane. The lane map gives `packs/*` that lane
only, so a pack-only change runs no core lane under `ci-local.sh --affected` (asserted by
`scripts/test-ci-lane-selection.sh`). The hosted workflows choose by port, not by lane, and
`packs/*` is the TypeScript port there, so a pack-only pull request also runs `ts-fast` and
`ts-unit`. That costs time and never makes a core lane depend on a pack. For each
pack with a TypeScript port, the lane runs the pack's typecheck, the pinned-vocabulary and
leaves-core-alone check, its load corpus and its own tests, against core's working tree.

- **Blocking** for a pack whose own files the change touches. A pack's own next change must be
  green against core's working tree, by fixing the pack or raising its floor.
- **A canary everywhere else.** A core change (`server/typescript/`, `client/web/`) also runs the
  lane. A pack it turns red is recorded as a named SKIP that reports the break and never fails the
  run. Blocking core on a preview pack's tests would recreate the coupling this ADR removes. A
  pack that reaches `stable` can be made blocking by decision, since breaking a stable pack
  through the covered surface is a core compatibility bug.

Core's own `build` and `typecheck` (the root `package.json` scripts, used by the pre-push hook,
`ci-local.sh` and `integration-test.sh`) name core's workspace directories instead of
`--filter '*'`, so a pack's red typecheck never fails core's.

### 8. Publishing

A pack stays **unpublished** (`"publish": false`, its npm package `private`) and is used by
adopter projects through the private prerelease registry (`docs/features/prerelease.md`) until
one estate project runs it with the drift gate enforced. Only then does it publish, as `0.x`
`preview`. This is the bar a `preview` library meets before promotion (`docs/features/libraries.md`), and the one ADR-0035 Amendment 6 sets for new vocabulary (ruling 3) and for a helper leaving `0.x` (ruling 2). A pack release
is tagged `pack-<name>-v<version>`, which the core release tags (`v<M>.<m>.<p>`), the site deploy
and the metamodel gate's baseline all ignore. The per-registry release path (a pack release
script, a pack version gate against its last tag, and a test against the lowest published core
in the range) is later work, built before the first publish.

### 9. What does not change

- **The bundled packs stay where they are.** The rules pack stays bundled and `experimental` in
  1.3.0. Whether it becomes bundled-stable or independent is decided when it is promoted. The
  experimental label already allows moving it in a minor.
- **Libraries stay embedded in core** (section 2 gives the one rule that follows for a library
  layer that needs a pack).
- **No load-time check yet.** A provider stating its version and needs, with the loader refusing a
  mismatch by name, is the right end state. It is a change to the provider contract in six ports,
  and an installer's range is enough while every user of a pack is an estate project.

## Consequences

- Pack work never moves `metamodelVersion`, a core package version, the npm lockstep set or the
  root changelog, and never needs the maintenance-branch procedure. Core can be released from
  `main` at any moment with pack work in flight.
- A pack joins the root Bun workspace (`packs/*/typescript`). That gives one install, and it lets
  a pack import core from source, as a workspace member does. The cost is a shared `bun.lock`, so
  a pack's third-party dependency can move a resolved version in core's lockfile. A separate
  workspace root under `packs/` was tried and does not work: Bun cannot resolve core's own
  `workspace:*` dev dependencies from outside the root workspace, so it would need published core
  packages and could not build against the working tree.
- A pack in a port other than TypeScript needs a hand-written provider in that port until the
  port can register vocabulary from a definition file (TypeScript and Rust can today).
- Core can break a preview pack without knowing it until the canary reports, and the pack is then
  fixed in its own pull request. That is the trade a separate repository would make, made
  visible.
- The boundary is held by gates, not by convention. A refactor that makes a core release script
  sweep every `package.json`, or a core file that imports a pack, fails the `gates` lane.

## Related

- [ADR-0023](ADR-0023-strict-metadata-provenance.md): downstream providers are outside the
  library's promise; this ADR brings one inside the repository without bringing it inside the bundle.
- [ADR-0035](ADR-0035-one-zero-stability-commitment-and-version-unification.md) Amendments 2 and 6: the two contracts,
  and the estate bar for publishing.
- [ADR-0050](ADR-0050-own-vs-projected-attributes.md): the composition invariant that "leaves core
  alone" points outward.
- [GOVERNANCE.md](../../GOVERNANCE.md#extension-packs-and-the-core-metamodel),
  [docs/features/extending-with-providers.md](../../docs/features/extending-with-providers.md),
  [docs/compatibility-policy.md](../../docs/compatibility-policy.md),
  [docs/CONFORMANCE.md](../../docs/CONFORMANCE.md), [docs/RELEASING.md](../../docs/RELEASING.md),
  [packs/README.md](../../packs/README.md).
