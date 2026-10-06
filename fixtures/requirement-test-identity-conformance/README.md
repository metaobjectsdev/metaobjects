# Requirement-test identity conformance corpus

Every port generates one test per requirement, in its own language and its own test
framework (ADR-0057). The generated files differ between ports and are meant to. This
corpus pins what must not differ: **which** tests a ledger yields, what each one is
**called**, whether it is **skipped**, the **digest** of the claim it tests, and what a
project's **filter** is shown when it chooses which requirements get a test.

TypeScript is the reference. The identity function is `requirementTestIdentities` in
`server/typescript/packages/codegen-ts/src/requirement-walk.ts`; a port reads that file
before it writes its own, and its test suite runs this corpus so the ports cannot drift.

## Fixture format

Each case is a directory:

- `input/` holds one or more metadata documents (`.yaml`).
- `options.json` is optional. Its keys are `grain` (`"concern"` or `"member"`) and
  `filter` (the **name** of one predicate from the list below). No other key is legal.
- `expected.json` holds `{ "tests": [...], "collisions": [...] }`.

A runner does three things, in this order:

1. Load `input/` with the port's loader, **strict**, and assert **no load errors**. Load
   the files in ascending file-name order, as the requirement-check corpus does. No
   expectation here is known to depend on that order; the rule is fixed so that none can
   come to.
2. Compute the test identities through the port's **public** generator seams: the grain
   option when `options.json` sets `grain`, and the filter option when it sets `filter`.
   An option the case does not set is not passed, so the port's own default applies. Then
   compute the witness-key collisions among those identities.
3. Compare both with `expected.json`.

### The named filters

A predicate cannot be written in a file five languages read. So a case names one, and
each port's runner implements this closed list in its own language and hands the predicate
to the port's filter seam. A name outside the list fails the case.

The predicate receives the **requirement view**: `subType`, `level`, `status`, `path`,
`package` and `implementedByTypes`. Between them the seven filters read every field.

| `filter` | The predicate over the requirement view |
|---|---|
| `all` | always true |
| `architectural` | `subType` is `architectural` |
| `live` | `status` is `live` |
| `level-5` | `level` is `5` |
| `package-acme-shop` | `package` is `acme::shop` |
| `path-under-Shop` | `path` is `Shop` or starts with `Shop.` |
| `claims-entity` | `implementedByTypes` contains `object.entity` |

- `level` is **absent** on an architectural requirement that declares none. Absent is not
  `5` and not `0`: the `level-5` predicate must answer false for it without failing.
- `path` is the dotted chain of requirement names from the root, with no package.
- `package` is the requirement's **effective** package: the one the node declares, else
  its file's, else the empty string.
- `implementedByTypes` is the distinct `<type>.<subType>` of the references that
  **resolve**, in first-seen order. A reference that does not resolve contributes nothing.

With no `filter`, the port's default applies: a requirement gets a test when it is
`functional` and its `level` is 4 or 5.

### What is compared

`tests` is compared after sorting both sides by `id`. Compare code units, not a locale
collation; every `id` in this corpus is ASCII. Each record is one generated test:

| Field | Definition |
|---|---|
| `package` | The requirement's effective package. `""` when it has none. |
| `path` | The dotted chain of requirement names from the root. |
| `unit` | What this one test stands for. Under `grain: concern` (the default), one test per **distinct** `<type>.<subType>` among the requirement's resolved references. Under `grain: member`, one test per **distinct** reference that resolves, spelt exactly as authored. In both grains a requirement with no resolved reference yields exactly one test, with unit `*`. |
| `id` | `<address> [<unit>]`, where the address is `<package>::<path>`, or the bare path when the package is `""`. |
| `witnessKey` | `req_` + mangle(address), then `__` + mangle(unit) unless the unit is `*`. mangle replaces each maximal run of characters outside `[A-Za-z0-9]` with one `_`. |
| `status` | The requirement's status. |
| `skip` | `null` when the status is `live` or `partial`. Otherwise the status: `planned` or `retired`. |
| `digest` | The requirement digest, below. The same for every test of one requirement. |

`collisions` is a list of `[id, id]` pairs: two tests with one `witnessKey`. Sort each
pair, then the list, before comparing.

### The requirement digest

`requirement-digest/v1`: the lowercase hex SHA-256 of the UTF-8 bytes of this text, where
`\n` is one line feed and every line ends with one.

```text
requirement-digest/v1\n
subType <n>\n<value>\n
level <n>\n<value>\n
status <n>\n<value>\n
statement <n>\n<value>\n
counterexample <n>\n<value>\n
implementedBy <count>\n
ref <n>\n<value>\n          (one per implementedBy entry, in authored order)
```

- `<n>` is the length in **bytes** of the value's UTF-8 encoding. `<count>` is the number
  of `implementedBy` entries.
- `level` is the decimal integer, or the empty value (`level 0\n\n`) when absent.
- Every value is the **effective** one: a value reached through `extends` is hashed as if
  it had been written on the node.
- In `statement` and `counterexample`, `\r\n` and a lone `\r` each become `\n` before the
  value is measured.
- `implementedBy` is hashed as authored: every entry, resolved or not, duplicates included.
- Nothing else is in the digest. Not the name, the path, the package, `title`,
  `description`, `notes`, `disposition`, `trackedBy`, `supersededBy`, or any nested
  requirement.

The worked example hashes

```text
requirement-digest/v1\nsubType 10\nfunctional\nlevel 1\n4\nstatus 4\nlive\nstatement 39\nAn order is recorded when it is placed.\ncounterexample 26\nA placed order has no row.\nimplementedBy 1\nref 5\nOrder\n
```

to `2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a`. Passing that text
to `printf` and piping it into `sha256sum` reproduces it.

### Where the expectations come from

`bun scripts/write-requirement-corpus-expected.ts identity` writes every `expected.json`
from the TypeScript reference. Each written file is then reviewed by hand against the
definitions above: the set of units, each `witnessKey` by applying the mangle rule, each
`skip` against the status, and the digests against each other. A case that yields more
than its row below says gets its **input** fixed.

A committed `expected.json` is never edited to make a port pass. A port that disagrees with
it is wrong, unless the reference is shown to be wrong first.

## Things the cases pin that are easy to miss

- **A filter replaces the default. It does not narrow it.** Every `filter-*` case keeps at
  least one requirement the default would drop, so a port that applies the project's
  predicate on top of its own default fails all seven. A port that ignores the option
  fails all seven too.
- **A filter chooses requirements, not tests.** In `filter-by-claimed-concern` the
  requirement that claims a template and an entity is kept, and its `template.prompt`
  test is kept with it.
- **Under `grain: concern`, distinct means distinct, not adjacent.** `concern-fanout`
  lists an entity, a template and a second entity, and yields two tests.
- **A reference to a missing member does not fall back to its object.**
  `member-grain-unresolved-dropped` names a member that an existing object does not
  have. That reference yields no test.
- **The digest is over the claim, so equal claims have equal digests wherever they sit.**
  The worked example's `Recorded` claim is reused under other names and paths, in another
  package and in no package, and its digest is `2714aa39…` every time.
- **The digest hashes what was authored, the unit is what resolved.** In `planned-skip`
  the reference `Refund` resolves to nothing, so the unit is `*`, and it is still in the
  digest. In `member-grain-duplicate-ref` three entries are hashed and two tests come out.
- **`unpackaged` is one document on purpose.** What a document without a package takes as
  its default when it is loaded beside a packaged one is a loader question, and this
  corpus does not ask it.
- **The carriage returns in `digest-multibyte-and-crlf` are written as YAML escapes**
  (`"\r\n"`, `"\r"`), so the value does not depend on the line endings of the file.

What the corpus does **not** pin: the text of a generated test file; the warning that
names the requirements a filter excluded; a requirement name outside ASCII; and whether an
`abstract` requirement gets a test (no case declares one).

## Cases

| Case | What it pins |
|---|---|
| `default-filter` | With no `filter`, an L1 to L5 tree and two architectural policies yield two tests: the functional L4 and the functional L5. The L1 to L3 nodes get none, and neither does a policy, including one that declares level 4. |
| `worked-example` | The reference model, which every port's generator test also renders: `Orders.Recorded` (functional, level 4, live, claiming the entity `Order`) and `Orders.Refunded` (functional, level 4, planned, no links), in `acme::shop`, under an L3 parent that gets no test. Both digests are pinned values: `2714aa39…` and `4ddcd781…`. |
| `concern-fanout` | One requirement claiming two entities and a template yields two tests, `object.entity` and `template.prompt`, with one digest. |
| `no-targets` | A live L4 with no `implementedBy` yields one test with unit `*`. Its key has no unit suffix. |
| `planned-skip` | `skip` is `planned`. A planned requirement naming a node that exists keeps that node's concern as its unit; one naming only a node that does not exist has unit `*`. |
| `retired-skip` | `skip` is `retired`, and the unit is `*`: the loader refuses `implementedBy` on a retired requirement. |
| `partial-not-skipped` | A `partial` requirement is not skipped: `skip` is `null` and `status` is `partial`. |
| `member-grain` | `grain: member`: one test per reference. Two entities, which are one concern, are two tests. A bare reference and a package-qualified one each keep the spelling they were authored with, in the unit and in the key, for an object and for a member. |
| `member-grain-unresolved-dropped` | `grain: member`: a reference that does not resolve yields no test, whether its object is missing or only its member is. A requirement none of whose references resolve yields one test with unit `*`. |
| `member-grain-duplicate-ref` | `grain: member`: an entity named three times in two spellings yields two tests, one per distinct spelling. |
| `package-in-address` | The same path, with the same claim, in two packages: two ids and two keys, one digest. A bare reference binds in each requirement's own package. |
| `unpackaged` | A document with no package: `package` is `""`, the address is the bare path, and the key starts `req_Orders_`. The digests are the worked example's. |
| `nested-path` | A five-deep path. Two branches end in the same three names (`Orders.Recorded.Quotable`), and their tests are told apart by the rest of the path. |
| `digest-claim-fields` | Two requirements that differ only in name, `title`, `description`, `notes`, `disposition` and `trackedBy` have one digest. A third that differs from the first by one word of the statement has another. |
| `digest-inherited` | A requirement that declares only a counterexample and reaches its level, status, statement and `implementedBy` through `extends` has the digest of the same claim written out in full, and the unit its inherited reference resolves to. |
| `digest-multibyte-and-crlf` | A statement holding two-byte and three-byte characters (55 characters, 78 bytes), and a counterexample holding a CR LF pair and a lone CR (64 bytes as authored, 63 as hashed). |
| `witness-key-collision` | `Orders.Recorded` beside `Orders_Recorded`: two ids, one key, and one entry in `collisions`. |
| `filter-all` | `filter: all` over an L1 to L5 tree and one flat policy: all six requirements get a test, the L1 to L3 nodes with unit `*`. |
| `filter-by-subtype` | `filter: architectural`: a flat policy and a levelled one get tests, and the functional L4 and L5 get none. Pins `subType`, and that a view with no `level` reaches a predicate. |
| `filter-by-status` | `filter: live`: a `partial` and a `planned` L4 are dropped, and their live L3 parent is kept beside the live L4. Pins `status`. |
| `filter-by-level` | `filter: level-5`: two functional L5 nodes and a levelled L5 policy get tests. Their L4 parent gets none, and neither does a flat policy, whose `level` is absent. Pins `level`. |
| `filter-by-package` | `filter: package-acme-shop` over two files: a root requirement and a nested one take their file's package, and one in each file declares the other file's package. The kept set follows the effective package, not the file. Pins `package`. |
| `filter-by-path` | `filter: path-under-Shop`: `Shop` and both its descendants are kept. `Shopfront` and its child are not. Pins `path` as the whole dotted chain, without the package. |
| `filter-by-claimed-concern` | `filter: claims-entity`: requirements claiming an entity are kept, a flat policy among them. One claiming only a template and one naming only a node that does not exist are dropped. Pins `implementedByTypes` as the concerns that resolved. |

## Who asserts it

| Port | Runner |
|---|---|
| TypeScript (reference) | `server/typescript/packages/codegen-ts/test/requirement-test-identity-conformance.test.ts` |
