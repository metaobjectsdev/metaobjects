# Governance

This file says who can do what in the MetaObjects project, how someone earns more rights, and
how decisions are made. [MAINTAINERS.md](MAINTAINERS.md) lists who holds each role today.

MetaObjects is primarily a one-person, part-time project. Today the creator, Doug Mealing, is the
only maintainer. These rules are written down now so that a second maintainer knows the terms
before putting in time.

## Roles

There are three roles.

| Role | Who | What they can do |
|---|---|---|
| Contributor | Anyone who opens an issue, a pull request, a review or a discussion | Propose changes. Review any pull request. Their reviews count toward earning a maintainer role |
| Port maintainer | Someone who owns one area: a language port, the web client, the docs, a generator family or a library (the areas are listed in [MAINTAINERS.md](MAINTAINERS.md)) | Review and merge pull requests that stay inside their area. Triage and label its issues. Publish that area's registry packages once publish rights are granted (see below) |
| Core maintainer | Someone responsible for the project as a whole | Everything a port maintainer can do, in every area. Approve changes to the model format, ADRs and releases. Grant and remove roles |

A person can maintain more than one area. Core maintainers can merge in any area, but should
leave a pull request to the area's port maintainer when there is one.

## How rights are earned

### Becoming a port maintainer

The usual bar is:

- at least 5 merged pull requests in the area, and
- about 2 months of reviewing other people's pull requests in that area.

Anyone can propose a person, including themselves, by opening an issue that links the merged
pull requests and reviews. A core maintainer then decides, using the decision process below.
The bar is a guide. A core maintainer can accept someone earlier when their work makes the case,
and should say why on the issue.

When the role is granted, the person is added to [MAINTAINERS.md](MAINTAINERS.md) and given write
access to the repository. Branch protection still applies to them like everyone else.

### Publish rights

Each port publishes to its own registry: npm for TypeScript and the web client, Maven Central
for Java and Kotlin, NuGet for C#, PyPI for Python. Publish rights are granted separately from
merge rights, because a published version cannot be taken back.

A port maintainer is added as an owner of their port's registry packages when:

- they have been a port maintainer for at least one release of that port,
- their registry account has two-factor authentication turned on, and
- they have walked through [docs/RELEASING.md](docs/RELEASING.md) for that registry with a core
  maintainer.

Publish rights cover the packages of that port only. A port maintainer publishes as part of a
release the core maintainers have approved (see "Releases" below). The registry owners for each
package are listed in [MAINTAINERS.md](MAINTAINERS.md), and that list is updated in the same
change that grants or removes access.

### Becoming a core maintainer

A port maintainer can become a core maintainer after at least 6 months in that role, by
invitation from the existing core maintainers. All existing core maintainers must agree.

## How decisions are made

### Lazy consensus

Most decisions are made by lazy consensus. A proposal is made in public, as an issue, a pull
request or a discussion. If no maintainer of the affected area objects within the waiting period,
it is accepted.

- A pull request inside one area can merge once a maintainer of that area approves it and the
  required checks pass. There is no fixed waiting period for these.
- A change that touches more than one area waits at least 3 days after it is ready for review,
  so the maintainers of each area can look at it.
- A maintainer does not approve their own pull request. Another maintainer of the area, or a
  core maintainer, reviews it. While the project has a single maintainer, that maintainer merges
  their own changes; this rule applies to an area once it has a second maintainer.
- An objection must give a reason and, where possible, say what would resolve it. An objection
  without a reason does not block.

If the people involved cannot agree, the core maintainers decide by majority. If the core
maintainers are split evenly, the creator breaks the tie only on the model format, ADRs and
releases (see below). On any other subject, an even split leaves the proposal unaccepted and the
status quo stands.

### Changes that need a core maintainer

These changes need explicit approval from a core maintainer, even when they sit inside one
area:

- **The model format.** Metamodel types, subtypes and attributes; the canonical serialized form;
  `expected-registry.json` and `metamodelVersion`; and the shared conformance corpora under
  [`fixtures/`](fixtures/). These are the contract every port has to match.
- **ADRs.** A new or amended decision record under [`spec/decisions/`](spec/decisions/).
- **The [compatibility policy](docs/compatibility-policy.md).**
- **Releases**, described next.
- **This file.**

### Releases

The core maintainers decide when a release happens, what version it carries, and what goes in
it. The procedure is [docs/RELEASING.md](docs/RELEASING.md). Port maintainers with publish rights
run the publish for their port inside that decision. They do not publish a version the core
maintainers have not approved.

### The creator's tie-break and veto

The creator, Doug Mealing, has two extra powers, limited to three subjects: the model format,
ADRs and releases.

- **Tie-break.** When the core maintainers are split evenly on one of these subjects, the
  creator decides.
- **Veto.** The creator can block a change to one of these subjects. A veto is written on the
  issue or pull request with the reason.

Outside those three subjects, the creator has one vote like any other core maintainer.

## Ownership

The `metaobjectsdev` GitHub organization, the package namespaces (`@metaobjectsdev` on npm,
`com.metaobjects` on Maven Central, `metaobjects` on PyPI, and the `MetaObjects` packages on
NuGet), the `metaobjects.dev` and `metaobjects.com` domains, and the MetaObjects name and
trademark belong to Doug Mealing LLC. Roles in this file grant access to these. They do not
transfer ownership.

The code is licensed under the [Apache License 2.0](LICENSE). Contributors keep the copyright to
their contributions and license them to the project under that license. There is no copyright
assignment and no contributor license agreement. Anyone may fork the code under the license; the
license does not grant use of the MetaObjects name or trademark.

Paid work or sponsorship does not grant a role, a vote or an exception to review. A change built
for a paying customer goes through the same review as any other change.

## Succession

The creator has stepped away when they say so in writing, or when they have not committed,
reviewed or answered on the project for 6 months.

When that happens:

1. The remaining core maintainers run the project and decide by majority vote. The creator's
   tie-break does not pass to anyone, so an even split leaves the proposal unaccepted and the
   status quo stands.
2. Doug Mealing LLC gives the remaining core maintainers admin access to the GitHub organization
   and owner access to every registry package, so that releases can continue.
3. If there is no other core maintainer, the port maintainers choose one or more of themselves as
   core maintainers by majority vote, and step 2 applies to them.
4. If there are no maintainers at all, the README is updated to say the project is unmaintained.
   The code stays available under the Apache License 2.0.

Ownership of the organization, the namespaces and the trademark stays with Doug Mealing LLC
throughout. The creator's veto does not pass to anyone.

## Stepping down and removal

### Stepping down

Any maintainer can step down at any time by opening a pull request that moves them to the
Emeritus section of [MAINTAINERS.md](MAINTAINERS.md). Their write access and registry ownership
are removed within one week.

### Inactivity

A maintainer who has not reviewed, merged or committed in their area for 6 months is asked
whether they want to stay. If they do not answer within one month, they move to Emeritus. They
can come back by asking; a core maintainer restores the role unless there is a reason not to.

### Removal

A maintainer can be removed for a breach of the [Code of Conduct](CODE_OF_CONDUCT.md), or for
misusing their rights, such as publishing a version outside an approved release or merging a
model-format change without core-maintainer approval. The core maintainers decide by majority,
not counting the person concerned. The person is told the reason directly, and the change to
[MAINTAINERS.md](MAINTAINERS.md) is made in a pull request.

If a registry account or repository access may be compromised, any core maintainer can suspend
that access at once. The decision on whether to restore it is made within two weeks.

## Changing this file

Changes to this file go through a pull request, stay open for at least 2 weeks, and need
approval from every core maintainer. The Ownership section can change only with Doug Mealing
LLC's agreement.

## Related files

- [MAINTAINERS.md](MAINTAINERS.md): who holds each role and each registry package today
- [CONTRIBUTING.md](CONTRIBUTING.md): how to propose a change
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md): how to report a vulnerability
