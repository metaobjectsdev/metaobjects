# Roadmap process — keeping GitHub in sync with the roadmap

How we track planned work, and how the GitHub surfaces stay in sync with the canonical roadmap.

## The model: one source of truth, mirrored

**`spec/roadmap.md` is the single source of truth.** It holds the **FR registry** (every feature
request + status + target release + tracking issue), the **Shipped / Active / Planned** detail, and
the **Release plan (1.0 → 1.x)**. Every roadmap fact lives here; the GitHub surfaces *mirror* it.

Three GitHub surfaces mirror the roadmap, each with one job:

| Surface | Role | Maps to |
|---|---|---|
| **Milestones** | the releases | `1.0` `1.1` `1.2` `1.3` `1.4` `1.x (later)` (= the Release plan) |
| **Issues** | one per FR (execution unit) | a row in the FR registry; label `FR` + an `area:*` label; milestone = target release; body links the design spec |
| **Project board** | a saved view (Now / Next / Later, grouped by milestone) | a view over the `FR`-labelled issues |

Design depth (the *why* and *how*) lives in `docs/superpowers/specs/*` and ADRs in
`spec/decisions/*` — issues link to these, they are not duplicated into issues.

## Current GitHub state (bootstrapped 2026-06-13)

- **Milestones:** `1.0`(#1) `1.1`(#2) `1.2`(#3) `1.3`(#4) `1.4`(#5) `1.x (later)`(#6).
- **Labels:** `FR`, `area:metamodel`, `area:serializers`, `area:ui`, `area:grid`, `area:perf`,
  `area:tooling`, `area:codegen`.
- **Issues:** one per planned FR — FR-019→#5, FR-020→#6, FR-021→#7, FR-022→#8, FR-023→#9,
  FR-024→#10, FR-025→#11, FR-026→#12, FR-027→#13, FR-028→#14, FR-029→#15, FR-030→#16,
  FR-031→#17, MCP→#18.

## Sync rules (do these together, in the same change)

1. **Adding an FR.** Allocate the next FR number (highest in the registry + 1 — currently the next
   is **FR-032**). In the *same* PR: add a registry row + a `## Planned` entry + a Release-plan
   slot in `spec/roadmap.md`, write/locate the design spec under `docs/superpowers/specs/`, and
   create the issue:
   ```sh
   gh issue create --title "FR-0NN — <title>" \
     --body "<one-line summary>

   **Spec / design:** <blob URL of the spec>
   **Target release:** <milestone>

   _Tracked in spec/roadmap.md (FR registry); status lives there._" \
     --milestone "<1.x>" --label "FR,area:<x>"
   ```
   Put the issue number back into the registry row.

2. **Changing status or target release.** Update the registry row (status/release) **and** move the
   issue's milestone (`gh issue edit <n> --milestone "<new>"`). The roadmap row is authoritative; if
   the two disagree, the roadmap wins and the issue is corrected.

3. **Shipping an FR.** Move it from Planned → Shipped in `spec/roadmap.md` (with the ship note), flip
   the registry status to ✅, and `gh issue close <n>` with a comment linking the shipping commit/PR.

4. **Cutting a release.** Close the milestone when its issues are done; bump the registry rows to ✅.

**Rule of thumb:** a PR that changes an FR's existence, status, or release **must** edit
`spec/roadmap.md`. The GitHub change (issue/milestone) accompanies it but is never the only record.

## Project board — one-time setup (manual)

The board could not be created via API from CI: the available token has
`repo`/`admin:org`/`workflow` scopes but **not `project`** (Projects v2 mutations require the
`project` scope). To create + auto-populate it once:

1. (If scripting later) grant the scope: `gh auth refresh -s project,read:project`.
2. In the org → **Projects → New project → Board**, name it **"MetaObjects Roadmap"**.
3. Add a built-in **workflow → "Auto-add to project"** filtering `repo:metaobjectsdev/metaobjects
   is:issue label:FR` — every `FR` issue then flows in automatically (no per-issue wiring, and new
   FR issues self-add).
4. Group the board **by Milestone** (gives the Now/Next/Later release columns) and add a `Status`
   single-select (Todo / In progress / Done) if desired.

Because the board auto-adds by the `FR` label, the **issues are the durable record** and the board
is a disposable view — losing/recreating it costs nothing.

## Public roadmap (website)

A curated, adopter-facing roadmap on `metaobjects.dev/roadmap` (Now / Next / Later) is summarized
**from** this file — it is not a separate source of truth. Refresh it when the Release plan changes.
