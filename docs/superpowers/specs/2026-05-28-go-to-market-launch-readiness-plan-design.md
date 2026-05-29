# Go-To-Market Launch Readiness — Design

_Date: 2026-05-28. Status: Approved (design); ready for per-workstream planning._

This is a **program-level** plan: a go-to-market readiness effort that decomposes into
seven independent workstreams, each of which gets its own spec → plan → implementation
cycle when we execute it. It does not itself contain implementation detail for any one
workstream — it sequences them and defines the launch.

> **Public-repo note.** This repo is public. The two marketing sites
> (`metaobjects.dev`, public; the commercial/contact site, private) live in separate
> sibling repos. This document refers to them generically and contains no private
> business, pricing, or strategy detail.

## Goal

**North Star: activation** — developers who run `meta gen` and keep the generated code.

That is the proof the product is real and the mental model makes sense. It is also the
single asset that later converts into any of three downstream doors — business leads,
job offers, or monetization — without having to commit to one now. We optimize for
activation; stars and traffic are momentum signals only.

## Strategy (decided)

- **All-five-ports splash.** The headline is "one schema, five languages, all
  installable." Publishing the C# port to NuGet and the Python port to PyPI is therefore
  a hard pre-launch gate, not a follow-up.
- **Open-source first; commercial aspirational.** Follow the bootstrapped open-core
  pattern (fully-open core, authentic build-in-public, monetize an adjacent surface
  later). The lightest adjacent surface — and the right one given the maintainer holds a
  full-time job — is **limited consulting / advisory**, positioned honestly and
  low-key on the commercial/contact site. No product is sold that does not exist.
- **Moderate time budget (~5–10 hrs/wk).** AI does the heavy execution; the maintainer
  reviews and approves. One well-timed coordinated launch plus a light build-in-public
  cadence — not a sustained multi-launch machine.
- **Sequencing: readiness-gated launch with light build-in-public ("A + light B").**
  Complete the readiness sweep before the coordinated launch, but post a few
  build-in-public devlogs during prep (starting when the first ports publish) to warm
  the channel and begin the visibility that serves the leads/jobs motive.

## Current state (from the 2026-05-28 readiness audit)

The hard part is done and trustworthy: five language ports, byte-identical behavior
enforced by shared conformance corpora, and a differentiated thesis ("the metamodel is
the durable spine; generated code is the disposable artifact"). What is missing is the
connective tissue a stranger needs in their first five minutes.

- **C#** is unpublished on NuGet. Four packages would ship (`MetaObjects`,
  `MetaObjects.Render`, `MetaObjects.Codegen`, and the `MetaObjects.Cli` as a
  `dotnet tool`). None carry packaging metadata; there is no version anywhere in the C#
  tree; there is no shared `Directory.Build.props`. Tests are green in CI. ~½–1 day.
- **Python** is unpublished on PyPI; the `metaobjects` name is available. The package
  builds cleanly and 610 tests pass; `py.typed` ships. `pyproject.toml` is missing
  license, project URLs, readme reference, classifiers, and authors, and the README
  understates scope. ~2 hours.
- **The repo's first impression is the real launch risk.** The README quickstart fails
  for three of five ports (tells users to install packages that are not published, and
  gives no Maven version for Java, which is live). There is no runnable demo. The
  version story (TS `0.7.x` vs Java `7.1.x` vs unpublished others) is unexplained and
  several version strings are stale/contradictory. Trust scaffolding
  (CONTRIBUTING/SECURITY/issue templates/badges) is absent. The `docs/` tree itself is
  good.
- **Websites are close.** The public site has a strong hero and positioning but a wrong
  headline version string and a ~6-month-stale `llms-full.txt` that contradicts shipped
  reality. The commercial/contact site is clean but frames an aspirational product and
  carries the same version-string bug.

## Workstreams

Each is an independent unit with a clear job; each gets its own spec/plan when executed.

| # | Workstream | Effort | Job |
|---|---|---|---|
| **WS1** | C# → NuGet | ½–1 day | Shared `Directory.Build.props`; per-package metadata (id, description, license, repo URL, readme, tags); CLI as `dotnet tool` (`PackAsTool` + `ToolCommandName=meta`); version; SourceLink + symbols; `docs/RELEASING-csharp.md`; first publish in dependency order (Render/MetaObjects → Codegen → Cli). |
| **WS2** | Python → PyPI | ~2 hrs | Fill `pyproject.toml` (license `Apache-2.0`, `[project.urls]`, `readme`, classifiers, authors, keywords); PyPI-correct README (absolute links, accurate scope); TestPyPI dry run + clean-venv install check; trusted publishing (OIDC) recommended; `docs/RELEASING-python.md`; first publish. |
| **WS3** | Version-story reconciliation | ~½ day | Decide the per-port version scheme (see below); fix every stale/contradictory string across repo + both sites; add a "Why different numbers?" note. |
| **WS4** | Repo launch-readiness | ~1 day | README rewrite with working quickstarts for all five ports; CI/license/version badges; `CONTRIBUTING.md`, `SECURITY.md`, bug/feature issue templates; point "how to contribute" at CONTRIBUTING, not `CLAUDE.md`. |
| **WS5** | The five-minute demo ("wow") | ~½–1 day | TypeScript end-to-end: `meta init` → declare an entity → `meta gen` → run the server → `curl` → `200` with JSON, captured as a runnable recipe + a README transcript + a short GIF. The single highest-leverage asset for an adoption goal. |
| **WS6** | Website fixes | ~½ day | Public site: fix the version string, regenerate or unlink the stale `llms-full.txt`, add a low-friction install CTA near the hero. Commercial/contact site: reframe the aspirational product as **light consulting/advisory** + keep the existing contact CTA, fix the version string, fix the dead OG-image config. |
| **WS7** | Launch assets + execution | ongoing | One-sentence positioning; launch narrative essay; comparison-to-alternatives page (largely exists on the public site); channel plan + timing; metrics instrumentation; build-in-public cadence. |

## Critical path & phasing

```
Phase 0  Version decision (WS3 core)              blocks releases, README, sites — do first, quick
Phase 1  Publish Python (WS2)  ‖  C# (WS1)         all five ports now installable  ▶ build-in-public begins
Phase 2  Repo readiness (WS4)  +  Demo (WS5)       quickstarts now reference real packages
Phase 3  Website fixes (WS6)                       ‖ Phase 2
Phase 4  Launch assets (WS7: narrative, positioning, comparison)   ‖ Phase 2–3
Phase 5  Instrument metrics                        download dashboards, Discussions, feedback CTA
Phase 6  Coordinated launch                        Show HN + build-in-public push + Console.dev/newsletters
```

The **demo (WS5) is the long pole** and gates a credible launch. Phases 2–4 run in
parallel. Light build-in-public posts begin at Phase 1 (devlog each release).

## The version story

Today the version number is wrong or missing in roughly six places across the repo and
both sites, and the schemes diverge (TS `0.7.x`, Java `7.1.x`, C#/Python unpublished).
For an all-five-ports splash this must be coherent. Direction:

- **Lead with a single "MetaObjects standard" version** as the headline — the thing that
  is genuinely identical across ports. This reinforces the conformance pitch rather than
  fighting it.
- **Each package keeps its ecosystem-native version underneath.** Never renumber
  already-published artifacts: Java stays `com.metaobjects 7.x`; TS stays `0.7.x`;
  C# and Python pick an intentional first version.
- **Add a one-paragraph "Why different numbers?" note** to the README and the public
  site so a newcomer is not confused.

**Phase 0 sub-decision (resolved 2026-05-28):** C# and Python publish at **`0.7.0`**,
matching the TypeScript reference track. This yields a clean two-bucket story — the newer
ports (TS, C#, Python) share `0.7.x`; the JVM ports (Java, Kotlin) share `7.x`,
continuing their established lineage — with the "Why different numbers?" note explaining
it and reinforcing the conformance pitch.

## Launch playbook (WS7 detail)

- **Positioning — kill the "what is this?" problem first.** Lead with meaning and pain,
  not features. Working line: _"Define your entity model once; generate idiomatic,
  drift-checked code for TypeScript, Java, C#, Python, and Kotlin. Prisma-style
  schema→code — but the schema is a language-neutral standard, not a TS file."_ Pain
  anchor: one renamed field silently breaks three services in three languages.
- **Assets.** Launch narrative essay (the "schema drift in the AI era" thesis,
  cross-posted to dev.to and linked from the Show HN first comment); the
  comparison-to-alternatives page (largely exists on the public site); the WS5 demo GIF.
- **Channels, in ROI order for a solo maintainer.** Show HN (one shot, timed after
  readiness) → build-in-public on X (continuous from Phase 1) → Console.dev (free
  review — submit) and developer newsletters → targeted subreddits (r/typescript,
  r/java, r/dotnet) and dev.to `#showdev`. Time Show HN and Twitter together to
  concentrate a star burst into GitHub trending. **Product Hunt deferred** until there is
  a hostable surface to convert its traffic.
- **Metrics — activation-first.** Public download deltas (npm/PyPI/Maven/NuGet), public
  docs traffic → quickstart completion, GitHub Discussions activity, and inbound. Stars
  are momentum only. Build-time telemetry is deferred (controversial, time-costly); use
  a lightweight feedback CTA instead.
- **Community.** GitHub Discussions now (searchable, async, solo-friendly). Discord only
  after traction.

## Non-goals (YAGNI)

- No Product Hunt launch, no Discord-at-launch, no paid advertising.
- No build-time telemetry pipeline.
- No commercial-product build — consulting/advisory is the only monetization surface, and
  it stays light.
- No renumbering of already-published Java artifacts.
- No sustained multi-"launch-week" machine; one good launch plus a light cadence.

## Comparable-project guidance

Follow the bootstrapped open-core pattern (one beachhead language — TypeScript — won
first, authentic founder build-in-public, fully-open core, real-pain narrative). Borrow
the recurring-launch cadence idea (per-port milestones as future "launch weeks") and
clear alternative-anchored positioning. Defer the commercial layer and Product Hunt until
there is a hostable surface; keep that surface adjacent to, never gating, the open core.

## Next step

Per-workstream planning, beginning with **Phase 0 (version decision)** and the two
releases (**WS2 Python**, then **WS1 C#**). Each workstream is taken through its own
spec/plan/implementation cycle.
