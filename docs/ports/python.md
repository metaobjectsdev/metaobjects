# Python port

Targets Python 3.11+ on the FastAPI / Pydantic stack. Ships the
metadata loader (canonical JSON + sigil-free YAML), conformance runner over the
shared corpora, the FR-004 render engine, and the entity / payload / router
codegen. Schema migrations are owned by the Node `meta` CLI (ADR-0015) — the
Python port has no `migrate` command by design; it consumes the canonical
`schema.postgres.sql` artifact verbatim.

## Install

Requires **Python 3.11+**. Published to PyPI as **`metaobjects`**:

```bash
pip install metaobjects        # or: uv add metaobjects
```

> **On an older default interpreter?** Many systems (e.g. Ubuntu 22.04) still
> ship `python3` = 3.10, where `pip install metaobjects` fails with a confusing
> `ERROR: No matching distribution found for metaobjects` (the wheel is
> `Requires-Python >=3.11`). Create the venv with an explicit 3.11+:
> `python3.11 -m venv .venv && . .venv/bin/activate`, then `pip install metaobjects`.

```toml
# pyproject.toml
[project]
requires-python = ">=3.11"
dependencies = [
    "metaobjects>=0.19",
]
```

> Contributing to the port itself? Work from source instead: clone the repo and
> `uv run --extra dev pytest` from `server/python/` (the in-repo dev workflow is
> `uv`-based, with `pytest` / `mypy` / `ruff` as the `dev` extra).

## Selecting the interpreter

`metaobjects` needs Python 3.11 or later to **run**. That floor is not being lowered. What
it generates has a lower one: the requirement tests it writes need only pytest and parse
under the Python 3.9 grammar, so they run on your project's own interpreter.

A project on an older interpreter therefore runs the tool with a different one, without
changing its own:

```bash
uv tool run --python 3.12 metaobjects gen
uv tool run --python 3.12 metaobjects verify

# or, with pipx (the interpreter is named by its executable)
pipx run --python python3.12 metaobjects gen
pipx run --python python3.12 metaobjects verify
```

Each fetches `metaobjects` into an environment of its own on the interpreter you name and
runs the console-script there. Your project's virtualenv, and the interpreter your tests
run on, are untouched.

## Configure

Drop metadata under `metaobjects/`:

```yaml
# metaobjects/meta.blog.yaml
metadata:
  package: acme::blog
  children:
    - object.entity:
        name: Author
        children:
          - source.rdb:
              table: authors
          - field.long:
              name: id
          - field.string:
              name: name
              required: true
              maxLength: 200
          - field.string:
              name: bio
              maxLength: 2000
          - identity.primary:
              fields: id
              generation: increment
```

### Custom providers (optional)

If your app needs a metamodel subtype the core doesn't ship, declare a
`Provider` and pass it through `from_directory`:

```python
from metaobjects.provider import Provider
from metaobjects import MetaDataLoader
from .providers import your_provider

result = MetaDataLoader.from_directory("./metaobjects", providers=[your_provider])
```

The provider object has the same four-member contract (`id`, `dependencies`,
`description`, `register_types(registry)`) as TS / C#. Composition errors
surface `ERR_PROVIDER_DUPLICATE_ID`, `ERR_PROVIDER_MISSING_DEPENDENCY`,
`ERR_PROVIDER_DEPENDENCY_CYCLE` — codes match the cross-port contract. See
[`../features/extending-with-providers.md`](../features/extending-with-providers.md)
for the full reference and
[`../recipes/extending-metaobjects-with-providers.md`](../recipes/extending-metaobjects-with-providers.md)
for a worked example.

## Generate

The `metaobjects` console-script (installed by `pip install metaobjects`) runs
codegen and the drift gate — there is no `python -m metaobjects.codegen`
module entry point:

```bash
metaobjects gen ./metaobjects --out ./generated \
  --generators entity,names,filter-allowlist,routes       # codegen → write
metaobjects verify ./metaobjects --out ./generated \
  --generators entity,names,filter-allowlist,routes       # drift gate; bare verify means --codegen
```

Codegen is opt-in, so both commands name the generators. `verify` regenerates exactly
the suite you name and compares, so pass it the same list `gen` ran. With no
`--generators`, `gen` writes nothing and `verify` reports that there is nothing to
check and exits 0: in CI that is a gate that checks nothing. `routes` needs `entity`
and `filter-allowlist` beside it (the router imports both), and `metaobjects gen`
warns when one is missing.

For multi-target projects (several `outDir`s, per-target generator/entity
selection, config-relative provider resolution), `metaobjects gen`/`verify` also
read a declarative [`metaobjects.config.yaml`](../features/cli.md) (#267) — run
either with no positional `<metadata_dir>` to use it; the flag path above stays
byte-identical.

### Reports

A concrete `object.report` whose read source is a `source.rdb` of `@kind: view` is served
like a keyless read-only projection. Four generators write one file each for a report `<R>`:
`entity` writes `<R>.py` (a Pydantic row model, one field per derived field),
`filter-allowlist` writes `<snake>_filter_allowlist.py`, `routes` writes `<snake>_router.py`
(`GET` list, `POST` answering 405, no `/{id}` route, and a repository Protocol with `list`
and `count` only, which you implement against the view), and `names` writes
`<snake>_names.py`. Every derived field with filter operators is filterable and sortable. A
row-model field that can be null is `T | None = None`; a measure with `@default`, and in a
`@spine` report a key or `@required` column of the spine entity, is the bare type
(`revenueOrZero: int` beside `revenueCents: int | None = None`). A
report with no view source, or an abstract one, generates nothing. The contract is in
[reporting](../features/reporting.md#how-a-report-is-served).

### Taking one tier and not the rest

`--generators <csv>` selects exactly the named generators from the available
catalog (`--list` names all of them). This is the answer for a project that wants
one tier without adopting the others — most often a **schema-only adopter** whose
tables come from `meta migrate` and whose application code is not generated at all,
but which still has physical table and column names hard-coded across its data
layer:

```bash
metaobjects gen ./metaobjects --out ./generated --generators names
```

It emits one `<entity>_names.py` per object and nothing else. Each carries
`<ENTITY>_SOURCE_PRIMARY_TABLE`, a `<ENTITY>_<FIELD>_COLUMN` per field, a
`<ENTITY>_COLUMNS_BY_FIELD` map, and `<ENTITY>_SOURCE_PRIMARY_SCHEMA` when the
source declares a `@schema`. On the 16-entity persistence-conformance model the full
server-side selection emits 68 files and this emits 19 — so adopting the names tier does
not drag a REST surface into a repo that does not want one.

**Pass the same `--column-naming` the schema was created with.** It defaults to
`literal` here, matching this port's `ObjectManager` — **not** `meta migrate`'s
`snake_case`. On a schema built by `meta migrate`, the default emits
`PROGRAM_PRICE_CENTS_COLUMN = "priceCents"` for a column actually named
`price_cents`: a constant that names a column which does not exist, which is worse
than the literal it replaced. Use `--column-naming snake_case` there. (A field
carrying an explicit `@column` is unaffected either way.)

**Both `pydantic` and `fastapi` are consumer-installed, not transitive deps of
`metaobjects` itself** — the entity/router files this emits `import pydantic`
and `import fastapi`, so add them before importing the generated code:

```bash
pip install pydantic fastapi
```

The entity-model generator emits one Pydantic **`BaseModel`** per entity (not
a `@dataclass`):

```python
# generated/Author.py
from pydantic import BaseModel, Field

class Author(BaseModel):
    id: int | None = None
    name: str = Field(max_length=200)               # required, max_length=200
    bio: str | None = Field(default=None, max_length=2000)
```

The router generator emits one FastAPI `APIRouter` per writable entity
(`source.rdb` with `@kind="table"`):

```python
# generated/author_router.py (excerpt)
router = APIRouter(prefix="/api/authors", tags=["authors"])

class AuthorRepository(Protocol):
    def list(self, limit: int, offset: int, sort: _SortClause | None) -> list[Any]: ...
    def count(self) -> int: ...
    def find_by_id(self, id: int) -> Any | None: ...
    def create(self, dto: Any) -> Any: ...
    def update(self, id: int, dto: Any) -> Any | None: ...
    def delete(self, id: int) -> bool: ...

def get_repository() -> AuthorRepository:
    raise NotImplementedError("Override get_repository via FastAPI dependency_overrides")

@router.get("")  # list with ?limit / ?offset / ?sort / ?withCount=1
@router.get("/{author_id}")
@router.post("", status_code=status.HTTP_201_CREATED)
@router.patch("/{author_id}")
@router.put("/{author_id}")
@router.delete("/{author_id}", status_code=status.HTTP_204_NO_CONTENT)
```

The router conforms to the cross-port API contract
([`docs/features/api-contract.md`](../features/api-contract.md)):
`?withCount=1` returns `{"rows", "total"}`; `?sort=field:asc|desc` uses
a static per-entity allowlist (HTTP 400 envelope on unknown field); 404
envelope is `{"error": "not_found"}`. Filter operators (`eq` / `ne` / …) **do** ship —
a per-entity filter allowlist is generated and the router parses `filter[field][op]`
into typed predicates. Remaining gaps are tracked in
[`server/python/src/metaobjects/codegen/KNOWN_GAPS.md`](../../server/python/src/metaobjects/codegen/KNOWN_GAPS.md).

Wire the router into your consumer FastAPI app:

```python
from fastapi import FastAPI
from acme.blog.author_router import router as author_router, get_repository
from my_app.persistence import SqlAlchemyAuthorRepository

app = FastAPI()
app.include_router(author_router)
app.dependency_overrides[get_repository] = lambda: SqlAlchemyAuthorRepository(session)
```

The generated `get_repository` raises until you override it. Any object with the six
`AuthorRepository` methods above works, including an in-memory dict while you try it
out. Serve the app with `uvicorn my_app.main:app --reload` (`pip install uvicorn`).

### `<entity>_names.py` — the physical names, as constants

The `names` generator is opt-in — select it with `--generators names` on
`metaobjects gen` (`--list` names the whole catalog). Selecting a generator is not
owning it: to change what `names` emits, `metaobjects eject names` copies its source
into `codegen/generators/` ([Own your codegen → Python](../features/own-your-codegen.md#python-metaobjects-eject)).
When selected, a project gets `<entity>_names.py`. The module
mirrors the metadata that declared it: every node it describes — the object,
each `source.rdb` child, each `identity.*` and `index.*` child — carries its
own `_TYPE`, `_SUB_TYPE` and `_NAME`, and a source's physical name sits under
the member named for **what kind of database object it is**:

```python
# generated/subscriber_names.py (excerpt)
SUBSCRIBER_TYPE: Final[str] = "object"
SUBSCRIBER_SUB_TYPE: Final[str] = "entity"
SUBSCRIBER_NAME: Final[str] = "Subscriber"          # the OBJECT's name, not the table's

SUBSCRIBER_SOURCE_PRIMARY_TYPE: Final[str] = "source"
SUBSCRIBER_SOURCE_PRIMARY_SUB_TYPE: Final[str] = "rdb"
SUBSCRIBER_SOURCE_PRIMARY_KIND: Final[str] = "table"
SUBSCRIBER_SOURCE_PRIMARY_TABLE: Final[str] = "subscribers"

SUBSCRIBER_CREATED_AT_FIELD: Final[str] = "createdAt"
SUBSCRIBER_CREATED_AT_COLUMN: Final[str] = "created_at"

SUBSCRIBER_IDENTITY_PRIMARY_TYPE: Final[str] = "identity"
SUBSCRIBER_IDENTITY_PRIMARY_SUB_TYPE: Final[str] = "primary"
SUBSCRIBER_IDENTITY_PRIMARY_NAME: Final[str] = "primary"

SUBSCRIBER_COLUMNS_BY_FIELD: Final[dict[str, str]] = {
    "createdAt": SUBSCRIBER_CREATED_AT_COLUMN,
}
```

| member | means |
|---|---|
| `<E>_TYPE` / `<E>_SUB_TYPE` | the metamodel type of the object — `object.entity`, `object.projection`, … |
| `<E>_NAME` | the **object's** metamodel name |
| `<E>_SOURCE_<ROLE>_*` | one `source.rdb` child, keyed by its `@role` (`PRIMARY` \| `REPLICA`) |
| `<E>_SOURCE_<ROLE>_KIND` | the source's `@kind` — `table`, `view`, `materializedView`, `storedProc`, `tableFunction` |
| `<E>_SOURCE_<ROLE>_TABLE` / `_VIEW` / `_PROC` / … | the physical name, under the member for that `kind` |
| `<E>_SOURCE_<ROLE>_SCHEMA` | the DB schema, emitted only when one is declared |
| `<E>_<FIELD>_FIELD` | the **logical** name — the field as your code and the wire call it |
| `<E>_<FIELD>_COLUMN` | the **physical** column — `@column` if declared, else the name through `column_naming` |
| `<E>_IDENTITY_<NAME>_*` / `<E>_INDEX_<NAME>_*` | one `identity.*` / `index.*` child, keyed by its metamodel name |
| `…_INDEX` | the database index name — on `identity.secondary` and `index.lookup` only |

**Why the physical name is not just `<E>_NAME`.** One member cannot hold a
table, a view and a stored procedure and still mean something. In a single run
it used to:

```
LEDGER_NAME          = "TBL_LDG_ENTRY"    KIND: "table"
CUSTOMERSUMMARY_NAME = "V_CUST_ROLLUP"    KIND: "view"
PROCOUT_NAME         = "SP_CUST_ROLLUP"   KIND: "storedProc"
```

A reader had to consult `<E>_KIND` to find out what they were holding, and in
none of the three did `<E>_NAME` hold the object's own name.

**A write-through entity has two physical names, and both have a home.** It
writes to a table and reads through a replica view; keying sources by role is
what gives the view a slot:

```python
LEDGER_SOURCE_PRIMARY_KIND: Final[str] = "table"
LEDGER_SOURCE_PRIMARY_TABLE: Final[str] = "tbl_ldg_entry"
LEDGER_SOURCE_REPLICA_KIND: Final[str] = "view"
LEDGER_SOURCE_REPLICA_VIEW: Final[str] = "v_ldg_entry_ro"
```

**The type segment (`SOURCE` / `IDENTITY` / `INDEX`) is load-bearing, and
fields are the one exception.** A field's subtype does not change what
`_COLUMN` denotes, while an object's decides table-vs-view and an identity's
decides unique-vs-not (ADR-0040 put uniqueness in the type). It is also what
keeps the members apart at all: `identity.primary` defaults its name to
`primary`, so an unnamed primary key and a `@role: primary` source would both
want `<E>_PRIMARY_*` — as the excerpt above shows, that is the common case,
not a corner one.

**`READ_ONLY` is not carried.** It was a derivation over `@kind`, not something
anyone declared, and nothing in any port read it. Ask
`<E>_SOURCE_<ROLE>_KIND` — that is what the author actually wrote.

**It follows `extends`, so a constant you do not find in a module is imported
from its parent's.** Python has no static inheritance, so an artifact whose
object extends another re-exports the inherited constants by REFERENCE:

```python
# generated/copay_auth_names.py (excerpt)
from .auth_names import (
    AUTH_ID_COLUMN, AUTH_ID_FIELD, AUTH_IDENTITY_PK_NAME,
    AUTH_SOURCE_PRIMARY_KIND, AUTH_SOURCE_PRIMARY_TABLE,
)

COPAYAUTH_NAME: Final[str] = "CopayAuth"            # its own name, always
COPAYAUTH_SOURCE_PRIMARY_TABLE: Final[str] = AUTH_SOURCE_PRIMARY_TABLE  # SHARED, spelled once
COPAYAUTH_ID_COLUMN: Final[str] = AUTH_ID_COLUMN
COPAYAUTH_COPAY_AMOUNT_COLUMN: Final[str] = "copay_cents"
```

Two forms, and which one you get is structural. An object with its OWN source
declares its own `_SOURCE_<ROLE>_*` constants; one that INHERITS its source — a
TPH subtype sharing its base's single table — takes them from the base module.
Either way each object keeps its own `_NAME`/`_TYPE`/`_SUB_TYPE`, which is what
a single-table hierarchy legitimately has two of. An abstract base a persisted
entity extends gets a module of its own carrying the columns and keys it
declares and **no `_SOURCE_*` at all** — it has no table, and must never
acquire one. `_COLUMNS_BY_FIELD` stays complete in every module, inherited
entries included.

**Prefer a typed handle where one exists.** If the ORM gives you a
type-checked object for the same thing, use that. Replacing it with a string
constant trades an error the compiler catches for one the database raises at
runtime. These constants are for the places with no typed handle: raw SQL, a
migration script, a log line, an external system's column mapping.

**In Python, that limit is never live advice — there is no typed handle to
prefer, anywhere.** Python's models, create/patch shapes, router and filter
allowlists all key by `field.name`; none of them names a physical column.
Unlike TypeScript (Drizzle column objects) or C#/Kotlin (EF properties /
Exposed `Column` objects), no generated Python object has an attribute bound
to a physical column. A hand-written `ObjectManager` query, a raw SQL string,
or a non-MetaObjects persistence layer (SQLAlchemy Core, `psycopg`) has
exactly one alternative to respelling `"created_at"` as a literal: importing
`SUBSCRIBER_CREATED_AT_COLUMN`. That is precisely why this generator ships on
by default here, unlike the JVM ports where it is opt-in — it fills a gap
every other Python generated artifact leaves completely open, rather than
adding a convenience alongside an existing typed one.

The constants resolve through the **same column-naming strategy**
`ObjectManager` uses (`literal` by default) — pass the identical value to
both (`--column-naming` at `metaobjects gen` time, `column_naming=` on
`ObjectManager`), or the constant a consumer imports names a different column
than the one a row actually lands in. `metaobjects verify` also takes
`--column-naming`, defaulting to the same `literal`, so a `verify --codegen`
regen resolves the same column strings `gen` did instead of reporting
spurious drift against a differently-configured run.

### Requirement tests

Declare what the software must do as `requirement.*` nodes and `metaobjects verify` checks
them on every run: it prints the ledger summary, and an error (a dangling reference on a
live requirement, a link above the floor, a live policy applied to nothing) exits non-zero.
`--require-implementers` (or `META_REQUIRE_IMPLEMENTERS=1`) also fails the run on a live
functional requirement that nothing implements. Those checks are core and are not
ejectable. A model with no requirement sees no change. Metadata that does not load is not
that: `verify` prints the load errors and exits non-zero, also when no generators are
selected and so no drift gate loaded it.

The `requirement-tests` generator is the other half. It is a reference helper and a
recommended approach, not a contract: `metaobjects eject requirement-tests` copies it, with
its default renderer, to `codegen/generators/requirement_tests.py`, wired as
`codegen.generators.requirement_tests:requirement_tests_generator`.

```yaml
# metaobjects.config.yaml
targets:
  tests:
    outDir: tests/generated
    generators: [requirement-tests]
requirementTests:                               # every key optional
  witnessModule: tests.requirement_witnesses    # the default
  grain: concern                                # or: member
  filter: codegen.requirement_hooks:include     # module:symbol, relative to this file's directory
  renderer: codegen.requirement_hooks:render    # module:symbol
  warnUncovered: true                           # the default
```

It writes `requirements/test_<pkgKey>_requirements.py` under the target's `outDir`, one
file per metamodel package, rewritten whole on every run. Each test looks up a **witness**:
a function named by the test's witness key, in the witness module. A `live` or `partial`
requirement with no witness fails, naming the function to write; a `planned` or `retired`
one is skipped and never looks one up.

```python
# tests/requirement_witnesses.py
def req_acme_shop_Orders_Recorded__object_entity():
    order = place_order()
    assert find_order_row(order.id) is not None
```

A missing witness module is "no witness". A witness module that exists and fails to import
raises its own error. There is no compile step, so a witness whose requirement is retired
or deleted is simply never called again: nothing reports it, and you delete it by hand.

| Key | Meaning |
|---|---|
| `witnessModule` | The dotted module the witnesses live in. |
| `grain` | `concern` (default): one test per distinct `<type>.<subType>` a requirement claims. `member`: one per distinct `implementedBy` reference that resolves. Anything else is a config error. |
| `filter` | A function taking the requirement view and returning a bool. It **replaces** the default of functional requirements at L4 and L5. The view has `sub_type`, `level` (`None` when the requirement declares none), `status`, `path`, `package` and `implemented_by_types`. |
| `renderer` | A function taking a `RequirementTestArgs` and returning a `RenderedTest(imports, source)` to replace the text of one test, or `None` to keep the default. Import both types from `metaobjects.codegen.requirement_hooks`, never from an ejected copy of the generator. |
| `warnUncovered` | `true` (default): one warning naming up to five requirements the filter left out. |

The block is read in config mode. The flag-only form
(`metaobjects gen ./metaobjects --out ./tests/generated --generators requirement-tests`)
runs the generator with its defaults. A `filter` or `renderer` whose module raises on
import is reported with the real cause. Both hooks, like a `providers` entry, are found
relative to the config file's directory, with no `PYTHONPATH=`. They differ in how they are
imported: a provider is imported with plain `importlib`, and a hook goes through the resolver
an owned generator is imported with, which loads the project's own copy of a module when
another copy is already cached and refuses a project package or module whose top-level name
is a standard-library module name (`types`, `json`): rename it. `metaobjects verify` goes
out of sync when a claim changes, because each test carries a digest of its requirement. A
package that loses its last requirement leaves its file behind: `gen` does not remove it,
`verify` lists it as `extra:`, and you delete it. The model and the other ports' spelling are in
[Generated requirement tests and witnesses](../features/requirements.md#generated-requirement-tests-and-witnesses).

### Declarative template-codegen (`--template-spec`)

Beyond the built-in Pydantic/FastAPI suite, the `metaobjects gen` console-script
runs **declarative Mustache template generators** from a JSON template-spec — the
cross-port contract shared with the C# port (see
[`docs/features/codegen-concepts.md`](../features/codegen-concepts.md#declarative-template-scopes)
and the neutral data dict in
[`docs/features/codegen-data-shapes.md`](../features/codegen-data-shapes.md)):

```bash
metaobjects gen ./metaobjects --out ./generated \
  --template-spec ./template-spec.json --templates ./templates
```

```jsonc
// template-spec.json — the cross-port shape
{ "generators": [
    { "name": "entity-doc",
      "scope": "perEntity",            // perEntity | perPackage | perModel
      "outputPattern": "{package}/{Name}.md",
      "template": "entity-doc",          // resolved under --templates
      "format": "markdown" }            // optional; a registered escaper format
]}
```

**The spec is auto-discovered.** Omit `--template-spec` and the CLI reads
`<projectRoot>/template-spec.json`, where projectRoot is the metadata dir's **parent** —
the same anchor `.metaobjects/` uses. The flag overrides it.

Prefer the conventional path over the flag, because **`verify --codegen` accepts no
`--template-spec`**: discovery is how the drift gate learns your template generators exist.
A spec reachable only by flag leaves `verify` regenerating a different generator list from
`gen` and reporting your committed template output as stale.

```bash
metaobjects gen ./metaobjects --out ./generated --templates ./templates
metaobjects verify --codegen ./metaobjects --out ./generated --templates-root ./templates
#   ^ both resolve <projectRoot>/template-spec.json — the gate agrees with the generator
```

(`gen` spells the templates dir `--templates`; on `verify` that name is the *subverb*, so
the directory flag there is `--templates-root`.)

`--template-spec` is **refused in declarative-config mode** (`metaobjects.config.yaml`,
no positional metadata dir) rather than silently ignored: a spec entry names no `target`
while config mode writes per target, so there is no outDir to render into. A *discovered*
spec is ignored there rather than refused.

Each spec entry derives the neutral template data dict for its scope and names
each file via the `outputPattern` placeholders (`{name}`, `{Name}`, `{package}`).
The named generators are **appended** to the `--generators` selection (there is no
default suite) and gated byte-identical
against the shared `fixtures/template-codegen-conformance/` corpus. Output is
format-agnostic (text/markdown/csv/json/xml/html), so the template-spec pass emits
no `__init__.py` into its tree. A `target` field is rejected (the Python port has
no output-target concept); for output to be regenerable, the **template** must emit
the `@generated` header itself (the write path refuses to overwrite files lacking
it).

### Universal browser-client hookup (React / Angular 18)

The router conforms to the same URL grammar as every other backend port,
so the universal browser client — React/TanStack today, Angular 18 once
FR-008 §2.5 lands — works against a FastAPI backend with no FastAPI-
specific client code. The same generated TanStack hooks (or Angular
services) that talk to a TS Fastify, Java Spring, Kotlin Ktor, or C#
ASP.NET backend will talk to this FastAPI router; the only consumer
wiring is the `EntityFetcher` base URL + auth.

## Use

The loader API is symmetric with the other ports in shape — `from_directory` /
`from_uris` / `from_string` factories returning a `LoadResult`, navigation
methods on its `.root` and child nodes. `MetaDataLoader` is re-exported at the
**top-level** `metaobjects` package (not `metaobjects.loader`); navigate the
tree with `.children()` and the resolving `get_meta_attr(name)` (own +
inherited via `extends` — see ADR-0039):

```python
from metaobjects import MetaDataLoader

result = MetaDataLoader.from_directory("./metaobjects")
author = result.root.children()[0]
name_field = [f for f in author.children() if f.name == "name"][0]
print(name_field.get_meta_attr("maxLength"))   # -> 200
```

To ask which package a node is in, call `effective_package()`. The `package` attribute holds
only a package the node declares itself, so it is `None` on an object that inherits its
file's root package:

```python
author.package              # -> None (declared no package of its own)
author.effective_package()  # -> "myapp::library"
author.resolution_key()     # -> "myapp::library::Author"
```

A `::`-relative package (`"package": "::parts"`) is expanded when the file is parsed, against
that file's root package, so `package` on such a node is already the full
`beta::other::parts`.

### Run-time validation

`run_validators` checks a data mapping against an entity's metadata, with no generated
code and no database. It is the Python port of TypeScript's `runValidators`: the same
rules, the same failure structure and the same message text.

```python
from metaobjects.runtime import run_validators

account = next(c for c in result.root.children() if c.name == "Account")
outcome = run_validators(account, {"name": "", "score": 101})
outcome.ok                                # -> False
[e.to_dict() for e in outcome.errors]
# [{"field": "name", "rule": "length", "message": "'name' must be at least 1 chars (got 0)",
#   "expected": {"min": 1}, "received": 0},
#  {"field": "score", "rule": "numeric", "message": "'score' must be at most 100 (got 101)",
#   "expected": {"max": 100}, "received": 101}]
```

It never raises. Every failure on every field is collected; a `required` or `type`
failure stops further checks on that one value only. The rules, by `rule` name:

| `rule` | Fires when |
|---|---|
| `required` | a `@required` field, a field with `validator.required`, or an assigned primary key (no `@generation: increment` or `uuid`) is absent or `None` |
| `type` | the value is not the field subtype's type; an array field is not a list; a value-object field is not a mapping |
| `length` | a string is longer than `min(@maxLength, validator.length @max)` or shorter than `validator.length @min`. A `@required` string has a floor of 1 unless a `@min` is authored |
| `regex` | a string does not fully match `validator.regex @pattern` |
| `numeric` | a number is outside `validator.numeric @min`/`@max` (inclusive) |
| `array` | an array's element count is outside `validator.array @min`/`@max` |
| `format` | a `field.uri` is not an absolute URI, or a `field.inet` is not an IPv4/IPv6 literal. `@lenient: true` opts out |

Keyword options: `partial=True` is update mode, where an absent key is untouched and
only present keys are checked. `store_filled=[...]` names fields the store fills on
insert, which are then exempt from `required` when absent. A field with a `@default` is
also exempt when absent. A value object is validated in full, and its failures are
labelled `field.member` or `field[i].member`.

`ObjectManager.validate(entity_name, data)` returns the same result for a loaded entity.
The `ObjectManager` write methods do not call it, so validate first when the data is
untrusted.

Three details follow JavaScript so that both runners report identical failures: string
length counts UTF-16 code units, a `bool` is not accepted as a number, and a number in a
message prints as JavaScript prints it (`2.0` as `2`, `1e-07` as `1e-7`).

## FR-004 — render

`render` takes a `RenderRequest` (only `payload` + `provider` are required; `ref`
defaults to `None`, `format` to `"text"`):

The provider resolves `ref` to a Mustache file under its root, so `lobby/welcome`
reads `prompts/lobby/welcome.mustache`:

```mustache
Welcome back, {{displayName}}. You have written {{postCount}} posts.
{{#posts}}- {{title}}
{{/posts}}
```

```python
from metaobjects.render import FilesystemProvider
from metaobjects.render.renderer import render, RenderRequest

out = render(RenderRequest(
    payload={
        "displayName": "Ada",
        "postCount": 12,
        "posts": [{"title": "Hello"}],
    },
    provider=FilesystemProvider("./prompts"),
    ref="lobby/welcome",
    format="xml",
))
```

`metaobjects.render.verify` drift-checks every `template.*` against its
`@payloadRef`. The Python renderer is conformance-gated to render byte-identical
output against the shared `fixtures/render-conformance/` corpus.

## FR-006 — output parsing

A template declares no payload type of its own (ADR-0056). Its request and response
types ARE the value objects' own Pydantic models, which the `entity` generator emits once
each as `<Name>.py`. So the prompt+parse story is two generators:

- `entity` emits one Pydantic v2 `BaseModel` per value object — and per sourceless
  `object.projection` — including every `@payloadRef` and `@responseRef` target and every
  value object nested in them (`field.object @objectRef`). The package is flat, so a value
  object whose short name another top-level object shares is package-qualified:
  `acme::alpha::Note` emits `AcmeAlphaNote.py` / `class AcmeAlphaNote`.
- `output_parser_generator` emits one `<template_name>_response_parser.py` per
  responding `template.prompt` (one declaring `@responseRef`, ADR-0052). It imports the
  `@responseRef` value object's model from its `<Name>.py`. `template.output` gets no
  parser at all — it renders outbound.

**Own a generator.** Every generator is a reference helper you can copy and change:
`metaobjects eject <name>` copies it into `codegen/generators/`, and you wire the copy as
`module:symbol` in place of its name. A project package or module whose top-level name is a
standard-library module name (`types`, `json`) is refused there with an error naming it:
rename it. See
[Own your codegen → Python](../features/own-your-codegen.md#python-metaobjects-eject).

Ejecting `routes` also hands over the helper runtime the generated routers call:
`filter_parser` and `constraint_errors` are copied into `codegen/runtime/`, and the owned
generator emits them into the generated package as `_runtime/` and imports them from
there (`from ._runtime.filter_parser import ...`). Fix a helper bug by editing
`codegen/runtime/<module>.py` and running `metaobjects gen`, with no upstream release
involved. `verify --codegen` never treats `codegen/runtime/` as drift. It does report a
`_runtime/` copy that is older than its source, as it would any stale generated file. The
core stays a package import in every output: the loader, registry, `render`, `extract`
and `ObjectManager`. A project that has not ejected `routes` keeps importing
`metaobjects.codegen.runtime`. The steps for pulling an upstream fix into your copy are in
[Own your codegen → The runtime your generated code imports comes with it](../features/own-your-codegen.md#the-runtime-your-generated-code-imports-comes-with-it).

Every template-tier generator that imports a model (`output-parser`, `extractor`,
`render-helper`) needs `entity` in the same run: `metaobjects gen --list` marks them
`(requires: entity)`, and `--generators` warns when `entity` is missing.

`render-helper` additionally needs an on-disk template root for its build-time drift
gate, and takes it from **`--templates <dir>`** — the same flag the `--template-spec`
pass uses. Pass it whenever `render-helper` is in the selection:

```
metaobjects gen metaobjects/ --out src/app/generated \
  --generators entity,render-helper --templates prompts
```

Omit it and the root is `prompts/` when that directory exists, else `templates/` — the
same rule `dotnet meta` uses, and `prompts` is the name the Node CLI has always used.

Until 1.0.5 that flag did not reach the generator: the registry factory took no
arguments and hardcoded `template_root="templates"`, so the drift gate read a directory
the caller had never named and the generator could not be aimed at a project whose
bodies live anywhere else. On `verify --codegen` the directory is `--prompts`
(`--templates-root` is its deprecated alias; there `--templates` is the boolean
prompt-drift subverb), and it MUST name the same root `gen` used — otherwise verify
regenerates `render-helper` against a different directory and reports the committed
helpers as stale.

Pythonic single-API throw-only convention — Pydantic raises `ValidationError`
on bad input; callers wrap in `try/except` per their own error policy (matches
the pydantic / Instructor / FastAPI / LangChain norm; a Result-style wrapper
would be un-Pythonic).

```python
# generated/NpcReply.py — emitted by the entity generator
from typing import Literal

from pydantic import BaseModel


class NpcReply(BaseModel):
    name: str
    level: int
    role: Literal["merchant", "guard", "elder"]
```

```python
# generated/npc_response_response_parser.py
from .NpcReply import NpcReply


def parse_npc_response(text: str) -> NpcReply:
    """Parse an LLM response into a typed ``NpcReply``.

    Raises:
        pydantic.ValidationError: when the input does not match the schema.
    """
    return NpcReply.model_validate_json(text)


__all__ = ["parse_npc_response", ...]
```

The strict `parse_*` is JSON-only (ADR-0053): an `@responseFormat: xml` reply gets the
tolerant `extract_lenient_*` and nothing strict.

Consumer wiring:

```python
from pydantic import ValidationError
from generated.npc_response_response_parser import parse_npc_response

llm_response: str = my_llm_client.complete(prompt_text)

try:
    npc = parse_npc_response(llm_response)
except ValidationError as e:
    log.warning("LLM returned malformed payload: %s", e)
    return None
```

The `@payloadRef` model types what a template RENDERS (the consumer constructs it and
passes it to the render helper, whose `payload` parameter is annotated with it); the
`@responseRef` model types what its parser RETURNS. The split is ADR-0052's: `@payloadRef`
is the request, `@responseRef` the reply, and they are usually different shapes.
`metaobjects.render.verify` walks both subtypes. The render engine reads a model payload
as readily as a `dict` (through its JSON-mode dump, so an enum renders as its value).
Cross-port design is at
[ADR-0010](../../spec/decisions/ADR-0010-template-output-parser-codegen.md) and
[ADR-0056](../../spec/decisions/ADR-0056-value-object-types-are-generated-once.md); the
feature reference is at
[`features/templates-and-payloads.md`](../features/templates-and-payloads.md#response-parsing-fr-006).

**The request model accepts unknown keywords.** The payload tier's copy used to carry
`extra="forbid"`; the value object's model keeps pydantic's default, so a mistyped keyword
argument is ignored rather than rejected. Payload bloat stays visible through `verify`'s
mustache-versus-payload check. The model does carry the value object's declared
validators (`validator.*`, `@maxLength`), so construction enforces them.

**The lenient mirror is keyed by the value object.** The response parser's tolerant tier
returns `<Vo>Extracted` (for example `NpcReplyExtracted`), declared in the parser module
itself, with one mirror per nested value object. Two parsers over the same response each
carry their own copy; a Python module scopes it.

**Consumer dependency.** Both generators emit code that imports `pydantic` (v2).
Add it via `pip install "pydantic[email]>=2"` or `uv add "pydantic[email]"` if you don't
already have it. The `[email]` extra is needed as soon as any field carries
`@stringFormat: email` — the shipped `iam` library's `User.email` does — because the entity
generator types that field `EmailStr`, which imports `email-validator` when the class is
defined. Without it the generated module fails at import, not at `gen`.

**Note on emitted output.** Both generators run `ruff_format(content)` on the
file before writing, so the literal emitted layout may reflow whitespace
slightly vs the snippets above. Function signatures, class definitions, and
import lines are stable.

## Capability snapshot

| Feature | Status |
|---|---|
| Entities + fields | Yes |
| Relationships + FK | Loader-level yes; relationship-navigation codegen is on the roadmap |
| Source kinds (table / view / storedProc) | Loader-level yes; codegen for non-`table` kinds is in progress |
| `field.currency` / `field.enum` / `field.object` + `@storage` | Loader-level yes; codegen for `field.object` `flattened` storage is in progress |
| Templates + render (FR-004) | Yes (`metaobjects.render`) |
| Payload-VO codegen | Yes — the `entity` generator's model for each value object IS the payload type (ADR-0056); no separate payload generator |
| Output parser codegen (FR-006) | Yes (`output_parser_generator` — Pydantic throw-only; imports the `@responseRef` value object's model) |
| Declarative template-codegen | Yes — `metaobjects gen --template-spec` (scope perEntity/perPackage/perModel + outputPattern; the cross-port JSON contract shared with C#) |
| Migrations | TS-only by design (ADR-0015) — no Python `migrate` command; consume the canonical `schema.postgres.sql` |
| Drift verify | Yes — template / payload drift (`metaobjects.render.verify`) |
| Requirement gate + requirement tests | Yes (`metaobjects verify`, on every run; `requirement-tests` emits pytest and is ejectable) |
| Runtime metadata | Yes (`metaobjects.runtime.ObjectManager` — DB-API 2 driver, pg8000/psycopg) + loader API + render engine |

## Conformance status (as of 2026-05-27)

| Corpus | Result |
|---|---|
| Metamodel (`fixtures/conformance/`) | 91 / 91 |
| YAML authoring (`fixtures/yaml-conformance/`) | 13 / 13 |
| Render (`fixtures/render-conformance/`) | 14 / 14 |
| Verify (`fixtures/verify-conformance/`) | 31 / 31 |
| Persistence (`fixtures/persistence-conformance/`) | 12 / 12 (runnable via `scripts/integration-test.sh python`) |
| API contract (`fixtures/api-contract-conformance/`) | 20 / 20 |

## See also

- [`server/python/README.md`](../../server/python/README.md) — module-level overview
- [`docs/features/`](../features/) — every feature shows the Python output inline
- [`docs/superpowers/specs/2026-05-23-python-codegen-engine-entity-generator-design.md`](../superpowers/specs/2026-05-23-python-codegen-engine-entity-generator-design.md)
- [`docs/superpowers/specs/2026-05-23-python-codegen-persistence-foundation-roadmap.md`](../superpowers/specs/2026-05-23-python-codegen-persistence-foundation-roadmap.md)
