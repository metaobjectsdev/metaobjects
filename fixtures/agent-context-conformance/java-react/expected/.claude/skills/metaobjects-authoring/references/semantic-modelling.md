# Semantic modelling: shaping vocabulary of your own

> Part of the `metaobjects-authoring` skill. Read it before you add or change a custom type,
> subtype, attribute or provider, and before you author nodes of vocabulary this project
> registered itself. Vocabulary someone else registered (core, a pack, a library) is used the
> way its own documentation says.

## Contents
- The habit to drop
- Three tiers
- Where one fact goes
- Things, not actions
- Type, subtype, attribute, child node or instance
- One base, variants that extend it
- Generated output: cover every fact, then do better
- Worked example
- Check before you register or commit

## The habit to drop

You will be handed a config file, a script or a block of code and asked to "put it in the
metadata". **Do not transcribe it.** A transcription carries the product's name, its version,
its statements and this environment's addresses into the model, and the model then has to
change every time one of those does.

The model says **what a thing is and how it relates to other things**. How it is realised
belongs to the generators and their configuration. The payoff is what the project owner wants
from custom metadata: the project decides once, in its generators, how it uses a kind of
database, queue or platform, and after that a new queue, role or plan is a few lines of
metadata that the generators already know how to set up. The model also stays portable,
because it never named the product. This layers on top of the tools that do the work
(Terraform, a Dockerfile, a platform's config) by generating their input. It does not replace
them.

## Three tiers

| Tier | Holds | Changes when |
|---|---|---|
| **Type** | What the thing is, and how it relates to other things: what holds it, what it holds, what it refers to | the domain is understood differently |
| **Subtype** | The kinds of that thing. Adds attributes and constraints. **Never adds a relationship** | a new kind appears |
| **Implementation** | Products, versions, syntax, file layout, names, addresses. Generated, tuned by configuration | a product is swapped, upgraded or moved |

Core is the model to copy: `source` (an object keeps its data somewhere) / `source.rdb` (that
somewhere is relational) / Postgres or SQLite as the `dialect` setting, with the DDL generated.
`source.rdb` says *relational*. It does not say Postgres and it does not say 18.

**The upgrade test.** If the product were swapped, its version upgraded, or the system moved to
another environment, would this line of the model have to change? Then it is not semantic and
does not belong in the model. A required *capability* ("supports full-text search") passes the
test and may be stated. The product that provides it does not.

## Where one fact goes

Ask in order; the first match decides.

| # | Question | Put it in |
|---|---|---|
| 0 | Computable from metadata already there? | nothing new: the generator derives it |
| 1 | What exists, what kind it is, what it relates to, who may do what to it, a rule it keeps, and it passes the upgrade test? | **metadata** |
| 2 | How one target writes things down: syntax, layout, an idiom, a sensible default? | **the generator**, as a default |
| 3 | A choice the same in every environment: product, version, dialect, naming? | **project configuration**, overriding the default |
| 4 | A *value* that differs per environment: address, credential, size? | **environment configuration**. The model may declare its name, never its value |
| 5 | A *fact* that differs per environment: one has something the others lack? | **metadata**, as a variant extending a shared base |

Configuration is layered, each over the one before: generator defaults, then optional shared
configuration (a module or file several projects load), then project configuration (the
project's MetaObjects config and its generator options), then environment configuration. A
generator must write working output from the model alone. If nothing useful generates until
configuration exists, move those answers into the generator as defaults.

## Things, not actions

Model what exists and what each thing holds. Never the steps that set it up.

<!-- meta-example: external-provider -->
```yaml
# Wrong: an action, which is one generator's output written down as metadata
- action.grant:
    name: grantReportingSelect
    statement: GRANT SELECT ON ALL TABLES IN SCHEMA ledger TO reporting_ro
```

<!-- meta-example: external-provider -->
```yaml
# Right: an identity, and the grants it holds, each typed by the kind of asset it is on
- role.service:
    name: reporting
    children:
      - grant.relational: { name: ledgerAccess, asset: ledger, access: read }
      - grant.queue: { name: exportsAccess, asset: exports, access: publish }
```

(These names are an illustration, not shipped vocabulary.) A thing can be referred to,
extended, overridden and queried ("who can read the ledger?"). The generator derives the verbs
from it: the statements that grant, and the ones that take away what is no longer declared.

The tell is a verb in a type, subtype or node name: `create`, `send`, `grant`, `sync`, `run`,
`enable`. The one exception is an operation the application offers its callers (an `approve`
command): that exists, takes input and is guarded, so it is a thing.

## Type, subtype, attribute, child node or instance

First write one sentence per thing that names no product and no step: *"A role is an identity
that acts in the system. It holds grants. A grant is on one asset."* Nouns are candidate types.
"Holds" and "is on" are relationships, and relationships belong to types.

| It is | Model it as |
|---|---|
| A thing with its own nature, relating to others as no existing type does | a **type** |
| A kind of an existing thing, relating to everything exactly as its siblings do | a **subtype** |
| A variant of one subtype that changes only the generated shape | **`@kind`** |
| A fact about one node: a flag, a closed choice, a limit | an **attribute** |
| Something a node has several of, each with facts of its own | a **child node** |
| One particular role, plan or queue | an **instance** (a node with a `name`), never a subtype |

- A subtype may narrow a relationship its type has (`grant.queue` requires a queue asset). It
  may not add a child type or a reference its siblings lack. If it needs one, put it on the
  type or make a new type. In a provider definition file the shared reference attributes and
  child rules go on `<type>.base`, and each subtype sets `extendsBase: true`.
- `role.billingService` or `plan.enterprise` is an instance promoted to vocabulary. Write
  `role.service` with `name: billing`.
- A list of names with their facts in sibling attributes (`features: [projects, exports]`
  beside `maxProjects: 50`) is a set of child nodes that was flattened. "Prefer an attribute to
  a new subtype" (`references/choosing-a-shape.md`) is about one concept on an existing type.
  It is not a reason to fold separate things into their parent.

Then run `references/choosing-a-shape.md` for each concept, and search before registering
(`meta types <term>`).

## One base, variants that extend it

Several nodes that are the same thing in different circumstances (per environment, tier,
region) share one `abstract: true` node. Each variant `extends` it and holds only its
differences. A child with the same type and name as a base child replaces it. A variant that
repeats a line of its base is a copy that will drift: delete the line. Mechanics:
`references/abstracts-and-overlay.md`.

## Generated output: cover every fact, then do better

The target is not a byte-for-byte copy of the hand-written file. It is a better one.

1. **Coverage.** List every fact the hand-written file states. Each needs a source: a node or
   attribute, a generator default, or a configuration key. A fact with no source is a gap to
   fix, never one to drop silently.
2. **Improvement.** The generator writes the file every time, so it states every default,
   grants the narrowest access the model allows, names things consistently, cleans up what was
   removed and traces each line to its node.

Improving never means changing a fact other code or stored data depends on: an existing table
name, column type or route is the specification (`references/adopting-existing-code.md`).

## Worked example

Asked to put an app's subscription plans in the metadata, the transcription looks like this:

<!-- meta-example: external-provider -->
```yaml
- plan.stripe:                          # a product as the subtype
    name: proMonthlyV2                  # a version in the name
    stripeApiVersion: "2025-08-27"      # a product version
    stripePriceId: price_1QxYz          # an environment value (test and live differ)
    features: [projects, exports]       # things flattened to names
    maxProjects: 50                     # ...with their facts beside them
    children:
      - action.syncToStripe: { name: pushPrice }   # a step the tooling runs
```

The sentences: *a plan is something an account subscribes to; it holds entitlements; an
entitlement is what the plan gives on one object of the model.*

<!-- meta-example: external-provider -->
```yaml
- plan.recurring:
    name: Base
    abstract: true
    interval: month
    children:
      - entitlement.access: { name: projects, objectRef: Project }
      - entitlement.quota: { name: projectLimit, objectRef: Project, limit: 3 }

- plan.recurring:
    name: Pro
    extends: Base
    children:
      - entitlement.access: { name: exports, objectRef: ProjectExport }
      - entitlement.quota: { name: projectLimit, objectRef: Project, limit: 50 }   # replaces Base's
```

The billing product became project configuration, its API version a generator default, the
price id an environment value, and the sync a generated script. A new API version or a new
billing provider changes no line of the model. A new limit changes one.

`objectRef` reuses the shipped name for a reference to an object. Reusing the name resolves
nothing by itself: register it in the provider as a reference to an object, so a renamed
`Project` fails the load instead of leaving the plans pointing at nothing.

## Check before you register or commit

1. Each type has a one-sentence description with no product, version or step in it.
2. Every relationship is on a type. No subtype adds one.
3. Every subtype is a kind that more than one node could be.
4. Anything with facts of its own is a child node, not an attribute value.
5. Every line passes the upgrade test.
6. Shared facts are on an abstract base. Variants hold only differences.
7. Every fact of a hand-written equivalent has a source, and the generators work with no
   configuration.

Tell the user where each fact of their original file went (model, generator default, project
or environment configuration), so nothing looks lost. The full page, with the reasoning:
`docs/features/semantic-modelling.md`.
