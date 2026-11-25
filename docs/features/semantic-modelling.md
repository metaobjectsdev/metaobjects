# Semantic modelling: shaping metadata of your own

This page is for anyone who adds vocabulary of their own to a MetaObjects model (a type, a
subtype or an attribute that a provider registers), and for the AI assistant that does it for
them. It teaches one habit: **the model says what a thing is and how it relates to other
things. How it is realised belongs to the generators and their configuration.**

It sits above three pages that each answer a narrower question:

- [downstream-metadata-decisions.md](downstream-metadata-decisions.md): should this be modelled
  at all, and does the shipped vocabulary already cover it?
- [ADR-0037](../../spec/decisions/ADR-0037-metamodel-vocabulary-expansion-decision-framework.md):
  for one concept on an existing type, is it a subtype, a `@kind` or an attribute?
- [extending-with-providers.md](extending-with-providers.md): how a provider registers it, in
  each language.

> **About the examples.** `plan`, `entitlement`, `role` and `grant` below are invented for this
> page; a provider of your own would register them. None of them ships, and the infrastructure
> names in particular are not a proposal. The independent packs under
> [`packs/`](../../packs/README.md) are preview and their vocabulary is not settled: where one
> of them records a product or a version on a node today, its README states the current fact
> and this page states the principle new vocabulary is held to.

## Why model this way

A semantic model makes the tenth addition as cheap as the first. A project decides **once** how
it uses a kind of database, a kind of queue or a deploy platform, and that decision lives in
its generators and their configuration. After that, a new queue, a new database or a new role
is a few lines of metadata, and the generators already know how to set it up, because they
know how this application behaves. That is also the aim of the default generators: pick a
platform, and its setup is written from the model.

It keeps the model portable too. Moving to another product or another platform changes
generators and configuration. The model stays as it is, because it never said which product it
was.

None of this competes with Terraform, a Dockerfile or a platform's own configuration. Those
stay the tools that do the work. The model is a layer on top that generates their input, so
that input is quicker to write, the same across a project and easier to move.

An application's own domain works the same way. Plans, notification rules, import feeds or
search settings, described semantically, generate their checks, tables and wiring every time
one is added.

## The three tiers

Every fact about a system belongs to exactly one of three tiers.

| Tier | Holds | It changes when |
|---|---|---|
| **Type** | The core nature of a thing, and how it relates to other things: what holds it, what it holds, what it refers to | the domain itself is understood differently |
| **Subtype** | The nuance within that nature: the kinds of the thing. A subtype adds attributes and constraints. It never adds a relationship | a new kind appears |
| **Implementation** | Everything else: products, versions, syntax, file layout, names, addresses. Generated, and tuned by configuration | a product is swapped, upgraded or moved |

The shipped vocabulary is built this way, so it is the best illustration:

| | Type | Subtype | Implementation |
|---|---|---|---|
| Where data lives | `source`: an object keeps its data somewhere | `source.rdb`: that somewhere is relational | Postgres or SQLite is the `dialect` setting; the DDL is generated |
| A link | `relationship`: one object refers to another | `relationship.composition`: the owner controls the target's lifetime | the foreign key, its index and `ON DELETE CASCADE` are generated |
| A value | `field`: an object has a named value | `field.currency`: the value is money in minor units | `bigint`, `Long` or `number`, and the formatter, are generated per language |

Nothing in the first two columns names a product. `source.rdb` says *relational*, the way a
future sibling would say key-value or graph. It does not say Postgres, and it does not say 18.

### The upgrade test

One question sorts most facts:

> **If the product were swapped, its version upgraded, or the system moved to another
> environment, would this line of the model have to change?**

If it would, the line is not semantic and does not belong in the model. Upgrading the database
does not change what the system *is*, so the version is not metadata.

A **capability** passes the test where a product fails it. "This store must support full-text
search" stays true across products and versions, so it is a fact the model may state. Which
product provides it is a choice the configuration makes, and the generator can then refuse a
product that does not provide it.

## The line: metadata, generator or configuration

Take one fact and ask these in order. The first that matches decides where it goes.

| # | Question | It goes in |
|---|---|---|
| 0 | Can it be computed from metadata that is already there? | **nothing new**: the generator derives it ([ADR-0023](../../spec/decisions/ADR-0023-strict-metadata-provenance.md)) |
| 1 | Does it say what exists, what kind of thing it is, what it relates to, who may do what to it, or a rule it must keep, and does it pass the upgrade test? | **metadata** |
| 2 | Is it how one target writes things down: syntax, file layout, an idiom, a sensible default? | **the generator**, as a default |
| 3 | Is it a choice this project makes that is the same in every environment: which product, which version, which dialect, a naming convention? | **project configuration**, overriding the generator's default |
| 4 | Is it a *value* that differs per environment: an address, a credential, a size? | **environment configuration**. The model may declare its name, never its value |
| 5 | Is it a *fact* that differs per environment: this one has something the others lack? | **metadata**, as a variant that extends a shared base (below) |

This is the same line a source-code generator draws for entities. The model says "an `Order`
has a required `total` in EUR". It does not say `NUMERIC(12,2) NOT NULL`, because the generator
knows that.

### Configuration is layered, and every layer is optional

A generator must write working output from the model alone. Configuration only overrides, in
this order, each layer over the one before:

| Layer | Holds | Where it lives |
|---|---|---|
| 1. Generator defaults | The choice that is right for most projects | The generator's own code |
| 2. Shared configuration (optional) | Choices several projects of one team make together | A module or file those projects load into their configuration |
| 3. Project configuration | This project's choices | `metaobjects.config.ts` and its generator options, `.metaobjects/config.json`, or the port's own config file |
| 4. Environment configuration | What differs per deployment | Environment variables or the deploy platform. Never the repository's model |

MetaObjects ships no special mechanism for layer 2. In TypeScript the configuration is code, so
a shared preset is an imported module, and an owned generator in any language can read a file
of your choosing.

Defaults are what keep setup cheap. If a model generates nothing useful until three files of
configuration exist, the line was drawn in the wrong place: move those answers into the
generator as defaults.

## Things, not actions

Model the things that exist and what each one holds. Do not model the steps that set them up.

An identity that may read one store and publish to one queue is **an identity with two
grants**. It is not two "grant" actions, and it is not a list of statements to run.

<!-- meta-example: external-provider -->
```yaml
# Actions: one generator's output, written down as metadata
- action.grant:
    name: grantReportingSelect
    statement: GRANT SELECT ON ALL TABLES IN SCHEMA ledger TO reporting_ro
```

<!-- meta-example: external-provider -->
```yaml
# Things: an identity, and what it holds on each asset
- role.service:
    name: reporting
    children:
      - grant.relational: { name: ledgerAccess, asset: ledger, access: read }
      - grant.queue: { name: exportsAccess, asset: exports, access: publish }
```

A thing can be referred to, extended, overridden in one variant, counted and checked. "Which
identities can read the ledger?" is a query over the second model and unanswerable from the
first. An action is one generator's output frozen into the model, and it says nothing once the
target changes.

The grants are typed by the kind of asset they are on, because what can be granted differs by
kind: a queue has publishing and consuming, a relational store has reading and writing. That
difference is the subtype's job (next section).

The verbs still happen. The generator derives them: from "this identity holds this grant" it
writes the statements that make it so, and the ones that take away a grant the model no longer
declares.

The tell is a verb in a type, subtype or node name: `create`, `send`, `grant`, `sync`, `run`,
`enable`. One exception is real: an operation the application itself offers to its callers,
such as an `approve` command, is a thing. It exists, takes input and is guarded. A step the
tooling performs to realise the model is not.

## Type, subtype or attribute

Start from a sentence about the thing that names no product and no step: *"A role is an
identity that acts in the system. It holds grants. A grant is on one asset."* The nouns are
candidate types. "Holds" and "is on" are the relationships, and they belong to the types.

| It is | Model it as | Test |
|---|---|---|
| A thing with a nature of its own, relating to other things in a way no existing type does | a **type** | You can say what it is and what it relates to without naming an existing type |
| A kind of an existing thing, relating to everything else exactly as its siblings do | a **subtype** | Code that knows only the type can still walk the model correctly |
| A variant of one subtype that changes only the generated shape | **`@kind`** on that subtype | ADR-0037, step 2b |
| A fact about one node: a flag, a closed choice, a limit, a rule on its value | an **attribute** | It has no facts of its own and nothing refers to it |
| Something a node has several of, each with facts of its own | a **child node** of its own type | You would refer to one, override one, or ask which nodes have one |
| One particular role, plan or queue | an **instance**: a node with a `name` | A second project would not have this one |

Three rules follow from the table.

**A subtype adds attributes and constraints, never a relationship.** `grant.queue` may add the
access values a queue understands and may require that its asset is a queue. That narrows a
relationship the type already has. It may not introduce a child type or a reference that other
grants lack. If it needs one, either every grant can have it (so it belongs on the type) or it
is a different type. When a provider keeps its vocabulary in a definition file, this is the
`<type>.base` entry: the base declares the reference attributes and child rules every subtype
shares, and each subtype sets `extendsBase: true` and adds only its own attributes.

**A subtype is a kind, not an individual.** `role.billingService` or `plan.enterprise` is one
instance promoted to vocabulary. Write `role.service` with `name: billing`.

**A thing with facts of its own is a node, not a list entry.** An attribute holding a list of
names, with the facts about each name in sibling attributes (`features: [projects, exports]`
beside `maxProjects: 50`), is a set of child nodes that was flattened. The existing advice to
prefer an attribute over a new subtype (extending-with-providers.md) is about one concept on
an existing type, and still holds. It is not advice to fold separate things into their parent.

Before registering any of it, search what exists (`meta types <term>`) and read
[downstream-metadata-decisions.md](downstream-metadata-decisions.md), which also lists the type
names reserved for planned core vocabulary.

## One base, and variants that extend it

When several nodes are the same thing in different circumstances (one per environment, plan
tier, region or tenant class), write what they share **once**, on an abstract node. Each
variant `extends` it and holds only its differences. A child that reuses the name of a base
child replaces it; any other child is added.

`abstract` and `extends` are core structural keys and need no vocabulary of their own
([abstracts-and-inheritance.md](abstracts-and-inheritance.md)).

<!-- meta-example: external-provider -->
```yaml
- role.service:
    name: reportingBase
    abstract: true
    children:
      - grant.relational: { name: ledgerAccess, asset: ledger, access: read }

- role.service:
    name: reportingProduction
    extends: reportingBase            # holds nothing: production is the base

- role.service:
    name: reportingStaging
    extends: reportingBase
    children:
      - grant.relational: { name: ledgerAccess, asset: ledger, access: write }   # same name: replaces the base's grant
```

This is row 5 of the table above. "Staging may write, production may not" is a fact about who
may do what, so it is a variant in the model. The staging host name is a value, so it is
environment configuration. A variant that repeats a line of its base is a copy that will drift,
so delete the line.

## Generated output: cover every fact, then do better

The target is not a byte-for-byte copy of the file someone would have written by hand. It is a
better file. Two checks:

1. **Coverage.** List every fact the hand-written file states. Each one must have a source: a
   node or attribute in the model, a generator default, or a configuration key. A fact with no
   source is a gap. Give it one (the model if it is semantic, the generator if it is detail).
   Do not drop it silently.
2. **Improvement.** A generator writes the file every time, so it can afford what people skip:
   every default stated, the narrowest access that satisfies the model, consistent names, the
   cleanup for what was removed, a comment tracing a line to the node it came from, and a check
   that fails when the model and the target disagree.

Improving means the file states more and states it better. It does not mean changing a fact
that other code or stored data depends on: when a system already exists, its table names,
column types and public routes are the specification, and the model reproduces them
([adopting-existing-models.md](adopting-existing-models.md)).

## Worked example: an application's own plans

A product sells subscription plans. The team asks for them to be "put in the metadata" so the
checks in the API and the pricing page stop disagreeing. The first draft is usually a
transcription of the billing code:

<!-- meta-example: external-provider -->
```yaml
- plan.stripe:                          # a product as the subtype
    name: proMonthlyV2                  # a version in the name
    stripeApiVersion: "2025-08-27"      # a product version
    stripePriceId: price_1QxYz          # a value that differs between test and live
    features: [projects, exports]       # things with facts of their own, flattened to names
    maxProjects: 50                     # ...with those facts scattered beside them
    maxSeats: 10
    children:
      - action.enableFeature: { name: enableExports, feature: exports }   # a verb as a node
      - action.syncToStripe: { name: pushPrice }                          # a step the tooling runs
```

Now the sentences, with no product and no step: *A plan is something an account subscribes to.
It holds entitlements. An entitlement is what the plan gives the account on one object of the
model.* Two types, one relationship each. The kinds: a plan is billed repeatedly or once; an
entitlement either opens an object or caps how many of it the account may hold.

<!-- meta-example: external-provider -->
```yaml
- plan.recurring:
    name: Base
    abstract: true
    interval: month
    children:
      - entitlement.access: { name: projects, objectRef: Project }
      - entitlement.quota: { name: projectLimit, objectRef: Project, limit: 3 }
      - entitlement.quota: { name: seatLimit, objectRef: Member, limit: 1 }

- plan.recurring:
    name: Free
    extends: Base

- plan.recurring:
    name: Pro
    extends: Base
    children:
      - entitlement.access: { name: exports, objectRef: ProjectExport }
      - entitlement.quota: { name: projectLimit, objectRef: Project, limit: 50 }
      - entitlement.quota: { name: seatLimit, objectRef: Member, limit: 10 }
```

Where each line of the first draft went:

| First draft | Now | Why |
|---|---|---|
| `plan.stripe` | `plan.recurring` | The kind of plan is how it is billed. The billing product is project configuration |
| `proMonthlyV2` | `Pro`, with `interval: month` | "Monthly" is a fact, so it is an attribute. "V2" is history, which git keeps |
| `stripeApiVersion` | a generator default | It fails the upgrade test |
| `stripePriceId` | environment configuration, under a name the generator derives | Test and live differ, so it is a value per environment |
| `features` + `maxProjects` + `maxSeats` | `entitlement.access` and `entitlement.quota` children | Each has facts of its own, and `Pro` overrides two of them by name |
| `action.enableFeature` | nothing | Holding the entitlement is what enables it. The check is generated |
| `action.syncToStripe` | nothing | A generator writes the billing catalogue; a script it writes pushes it |

`objectRef` is the name the shipped vocabulary already uses for a reference to an object, so
the new types reuse it and the reference is resolved at load: renaming `Project` without
updating the plans fails the build.

Run the upgrade test. The billing provider releases a new API version: no line changes. The
company moves to another provider: no line changes. Pro's project limit becomes 100: one line
changes. That is the model doing its job.

Then the output. The hand-written equivalent was a constants file and `if (plan === "pro")`
checks spread through the API. Coverage: every limit and every gate in that file now has a
source in the model. Improvement: the generated check covers every plan for every entitlement,
so a new entitlement cannot be forgotten on one plan; the pricing page reads the same data the
API enforces; and the billing catalogue is written from the model, not kept by hand beside it.

The configuration, layer by layer:

```ts
// metaobjects.config.ts
import { defineConfig } from "@metaobjectsdev/cli";
import { billing } from "@acme/metaobjects-preset";                  // 2. shared, optional
import { entitlementChecks, billingCatalogue } from "./codegen/generators/plans";

export default defineConfig({
  generators: [
    entitlementChecks(),                                             // 1. generator defaults
    billingCatalogue({ ...billing, provider: "stripe" }),            // 3. project choices
  ],
});
// 4. The price ids and the API key are read from the environment at deploy time, by name.
```

## The wrong turns an assistant makes

An assistant asked to "add this to the metadata" tends to transcribe the file in front of it.
Each of these is that habit in a different place.

| Wrong turn | The tell | Do this |
|---|---|---|
| **A product or a version in the model** | A node, subtype or attribute names a vendor, a product or a version number | Say the kind (`relational`, `queue`) or the capability. Product and version are configuration |
| **A verb as a node** | A name starts with `create`, `send`, `grant`, `sync`, `run`, `enable` | Model the thing that exists and what it holds. The generator derives the step |
| **A one-off subtype that adds a relationship** | A subtype used by exactly one node, or one that accepts a child or reference its siblings do not | Make it an instance of an existing subtype. Put the relationship on the type, or make a new type |
| **Everything flattened into attributes** | A list of names with their facts in sibling attributes; parallel lists; a name that encodes two facts | Give each thing a child node of its own type |
| **An environment value in the model** | A host name, URL, credential, account id or size, or the same node copied once per environment | Values go in environment configuration. Real differences go in a variant that extends a shared base |
| **A model that needs configuration to mean anything** | Nothing useful generates until several config files exist | Move those answers into the generator as defaults |
| **Reproducing the hand-written file exactly** | The generator is tuned until a diff against the old file is empty | Check coverage of its facts, then let the generated file be better |

## Checklist

Before registering vocabulary, and again before committing a model that uses it:

1. Each type has a one-sentence description with no product, no version and no step.
2. Every relationship is declared on a type. No subtype adds one.
3. Every subtype is a kind that more than one node could be.
4. Every attribute is a fact about its own node. Anything with facts of its own is a child node.
5. Every line passes the upgrade test.
6. Shared facts sit on an abstract base. Variants hold only differences.
7. Every fact a hand-written equivalent states has a source: model, generator default or
   configuration.
8. The generators produce working output with no configuration at all.

## See also

- [extending-with-providers.md](extending-with-providers.md): the provider contract, `register`
  and `extend`, and the wiring in each language.
- [downstream-metadata-decisions.md](downstream-metadata-decisions.md): whether to model a
  concept at all, converging with core, and the names core reserves.
- [ADR-0037](../../spec/decisions/ADR-0037-metamodel-vocabulary-expansion-decision-framework.md):
  subtype, `@kind` or attribute for one concept.
- [abstracts-and-inheritance.md](abstracts-and-inheritance.md): `abstract`, `extends` and how
  they resolve.
- [own-your-codegen.md](own-your-codegen.md) and
  [../recipes/write-your-own-generator.md](../recipes/write-your-own-generator.md): where the
  implementation tier lives.
