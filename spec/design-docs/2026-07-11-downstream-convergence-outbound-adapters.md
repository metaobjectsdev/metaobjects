# Downstream convergence signal: outbound notification adapters

**Date:** 2026-07-11
**Status:** informational — convergence evidence from a downstream consumer; nothing to action pre-1.0.
**Scope:** FR-024 (declared API) / FR-034 (ecosystem tier) planning input. See the adopter-facing
guide [docs/features/downstream-metadata-decisions.md](../../docs/features/downstream-metadata-decisions.md)
for the prescriptive version of the lessons below.

## The signal

A downstream monitoring consumer (TS port) independently modeled outbound notification delivery as a
project-registered subtype: channel behind a closed structural-variant discriminator (`@kind`), the
node protocol- and address-free, config declared as env-key **names** only with a generated
fail-closed check. Without having read the specs, it re-derived two things the ecosystem tier already
charts:

1. **The consumed-edge address contract** — a fail-closed "missing required config" check, names-only,
   values never in metadata — is FR-034's consumed-edge address contract, arrived at from scratch.
   Convergence evidence that the FR-034 shape is the natural one a consumer reaches for.
2. **Protocol off the type axis** — channel behind `@kind`, node protocol/address-free — matches
   ADR-0030's axiom ("a command over a queue is still `api.operational` — that's a binding, not a
   kind").

## The two pieces that stay homeless even in a finished FR-024 + FR-034 world

1. **Non-network channels.** Running a local command, piping to a process, writing to a local
   stream — no chartered `binding.*` covers these. Open charter question: do they get `binding.*`
   members, or is that explicitly application-tier? A ruling either way tells downstream consumers
   whether to model them at all.
2. **Template-composition operations.** An operation whose payload is a *rendered `template.output`*
   (payload VO + template + transport). Its only precedent is the unscheduled roadmap-Future
   "Declared LLM-operation" (input VO + template + output VO + parse strategy as one node).

## The generalization worth considering

Generalize the roadmap-Future "Declared LLM-operation" into a **declared outbound operation**:
payload VO + optional template + optional response ref + a one-method client seam (per ADR-0024's
"own the payloads + the seam, never codegen the transport" boundary). One convention would then cover
LLM calls, notification/webhook adapters, and MCP exposure — inbound vs outbound being the
`surface.provided`/`surface.consumed` edge, not the operation. The **actual blocker** is FR-034
§1.2.4 (external, non-meta-modeled systems deferred) — the consumer's targets are all external
systems that publish no metaobjects model.

## Recommendation

Nothing to action pre-1.0. When FR-034 planning resumes: cite this as convergence evidence, resolve
the non-network-channel binding question, and consider the declared-outbound-operation generalization.
A downstream consumer keeps such a subtype protocol/address-free and clear of the chartered names
(`api`/`operation`/`surface`/`binding`) so it can fold into the convention later without a breaking
rename. One consumer isn't enough evidence to add core vocabulary — a **second** independent consumer
wanting the same concept makes it an ADR-0011 consumer→core promotion candidate.
