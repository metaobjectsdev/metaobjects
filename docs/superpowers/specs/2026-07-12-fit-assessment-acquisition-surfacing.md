# Fit-assessment acquisition surfacing — design

_Status: Proposed · 2026-07-12_

The single highest-leverage acquisition channel for MetaObjects: a **zero-install,
"point your coding agent at your existing repo and it finds the drift already biting
you"** flow, built on the shipped
[`metaobjects-fit-assessment`](../../../agent-context/skills/metaobjects-fit-assessment/SKILL.md)
skill and its blinded Phase-0 validation
([design + retro-test](2026-07-12-metaobjects-fit-assessment-design.md)).

The target user already has a project and already feels schema/prompt/code drift.
The pitch is **drift archaeology**: the assessment doesn't say "drift will happen" —
it mines the target's own git history and reports "it already happened, here are the
commits." Phase 0 proved this lands: a blinded run on a real pre-adoption production
codebase found specific, git-verified incidents (a production CHECK-constraint
violation after an enum drifted across 146 migrations; a column-width divergence
still live at assessment time; a one-field addition that fanned out to 28 files) —
and its misses were all conservative under-predictions.

**Honesty constraints (post-oversell-review, non-negotiable in every copy block
below):** never "drift is structurally impossible"; the honest strongest forms are
"drift breaks the build" and "it already drifted — here's proof from your own
history." The assessment is read-only, propose-only, evidence-cited, and built to
say NOT A FIT — state that as the strength it is. No version numbers in hero copy.
See [2026-07-12-tenets-materializing-and-oversell-review.md](2026-07-12-tenets-materializing-and-oversell-review.md).

This doc is copy + mechanism only. It edits nothing; every block is ready-to-paste
into its named target file.

---

## 1. Research memo

### 1.1 Per-tool invocation

Verified 2026-07-12 against live vendor docs (sources in the right column). The
pattern that emerged: **every major agent can act on a URL in a plain sentence**,
but each has one gate (a confirmation prompt, a flag, a default-off network), so
the copy should lead with the universal sentence and keep per-tool notes one line
each.

| Tool | Lowest-friction invocation | The one gate | Source |
|---|---|---|---|
| **Claude Code** | Paste the sentence — the built-in `WebFetch` tool fires on its own. | Confirms new domains once (pre-allow via a `WebFetch(domain:metaobjects.dev)` permission rule). Note: WebFetch is *lossy by design* (Markdown-conversion + an extraction model) — for verbatim fidelity on a ~500-line prompt, say "download the raw file with curl, then follow it." | code.claude.com/docs/en/tools-reference; …/permissions |
| **Cursor** (agent) | Paste the URL + instruction in Agent chat; the agent's Web/Browser tools fetch it. | The old documented `@Link` pasted-URL auto-fetch is gone from the 2026 docs (unverified whether the behavior remains); if the agent doesn't fetch, use the save-into-workspace fallback. | cursor.com/docs/agent/tools |
| **Windsurf** (Cascade) | Paste the URL in the message — pasted-URL reads run locally. | None for a pasted URL (the "Enable Web Search" admin setting gates open-web *search*, not a specific pasted URL). | docs.devin.ai/desktop/cascade/web-search (redirect target of docs.windsurf.com) |
| **GitHub Copilot** (VS Code chat/agent) | `#fetch https://metaobjects.dev/assess.md — run this assessment against the open workspace.` (a bare URL in the prompt also works). | VS Code confirms before accessing external URLs. Copilot on github.com has web *search* only, no arbitrary-URL fetch → paste/file route there. | code.visualstudio.com/docs/copilot/chat/copilot-chat-context |
| **OpenAI Codex** (CLI) | `codex --search`, then the sentence. Without `--search`, Codex proposes `curl` — approve it once. | `web_search` defaults to `"cached"` (an index, not live pages — a deliberate prompt-injection mitigation) and shell network access is off by default. Codex in ChatGPT (cloud): internet off by default per environment → paste/file route. | developers.openai.com/codex/cli/reference; …/codex/cloud/internet-access |
| **Gemini CLI** | The sentence with the URL — the built-in `web_fetch` tool fires (this "read this URL and apply it" phrasing is the docs' own usage example). | Confirms before fetching (skipped in auto-approve modes). | google-gemini.github.io/gemini-cli/docs/tools/web-fetch.html |

**Universal fallback — stronger than pasting:** every one of the six reads
*workspace files* with zero web permissions. So the fallback that works everywhere
(locked-down enterprise setups, Codex cloud, fidelity purists) is:

```bash
curl -fsSL https://metaobjects.dev/assess.md -o metaobjects-assess.md   # anywhere in the workspace; don't commit it
```

then tell the agent: *"Read `metaobjects-assess.md` and run the assessment it
contains against this repository."* Pasting the file's contents into the chat is
the secondary fallback (all six accept large Markdown pastes; no vendor documents
a paste-size ceiling — for a ~500-line prompt the file route is safer).

**Two ecosystem facts that shaped the design:** (1) **no tool auto-discovers
`llms.txt`** — the convention works only when a site steers agents to it or a
human points at it, so the `llms.txt` entry below is cheap discoverability for
agents already reading the index, not a distribution channel by itself; (2) the
"fetch a URL and follow its instructions" shape is exactly what vendors'
prompt-injection warnings describe — the honest counter is to *invite the human to
read the prompt first* (it is one Markdown file), which the copy below does
explicitly. AGENTS.md doesn't apply pre-adoption: the prospect's repo has no
MetaObjects files yet — that absence is why the hosted-URL channel exists.

### 1.2 Hosting recommendation

**Serve the prompt itself as a static file at `https://metaobjects.dev/assess.md`**
(one file, `www/assess.md`, next to `llms.txt` in the site repo), with the raw
GitHub URL as the documented mirror. Rationale:

- **Short + brandable beats raw.** `raw.githubusercontent.com/...` is 122
  characters of unmemorable path; `metaobjects.dev/assess.md` survives being said
  out loud, printed on a slide, and typed from memory. The raw URL stays the
  works-today fallback and the "trust the repo more than the site" option (it is
  live now: HTTP 200, `text/plain`, ~30 KB — one practical fetch).
- **A file, not a redirect.** One correction to the brief: metaobjects.dev deploys
  via **GitHub Pages** (`actions/upload-pages-artifact` on `www/`, no Jekyll pass —
  see the site repo's `.github/workflows/deploy.yml`), not Cloudflare Pages, so
  there is no `_redirects` mechanism anyway. Serving the actual file is also
  strictly better: agent URL-fetch tools handle a 200 with markdown text
  universally, while redirect-following varies by tool. Keep the `.md` extension —
  GitHub Pages serves extensionless files as `application/octet-stream` (a download,
  not a fetchable page).
- **Discovery rides the existing conventions.** The site already ships `llms.txt`
  (the Answer.AI convention agents and LLM crawlers look for); the §2 `llms.txt`
  block makes `assess.md` discoverable to any agent that reads the index — the same
  motion the fit-assessment design (§7.3) already specified. `AGENTS.md` is the
  per-repo convention and does not apply here (the prospect's repo has no
  MetaObjects files yet, by definition — which is exactly why the hosted-URL
  channel exists).

### 1.3 GTM patterns (from audit/assessment-flow dev tools)

Five transferable patterns, each with the rationale and a source:

1. **Quantified friction in the CTA itself.** Aikido leads with "No credit card
   required · scan results in 32 secs"; Snyk with "free … in minutes, no credit
   card." Developers respond to a testable promise of time-to-value. This flow can
   honestly beat both: *read-only · no install · no signup* — and "minutes of your
   agent's time, none of yours." (aikido.dev; snyk.io; OpenView PLG benchmarks —
   67% of dev-tool companies lead with a free offering.)
2. **Proof-before-signup — findings in code the visitor recognizes, or their own.**
   Greptile's landing leads with real bugs it caught in NVIDIA/PyTorch/Solana repos
   and a zero-commitment "Paste a Pull Request. Get a Review." page; Lighthouse is
   the zero-install audit precedent. This flow is the strongest structural form of
   the pattern: the proof is produced *inside the user's own repo by their own
   agent* — nothing is taken on faith. (greptile.com, greptile.com/examples;
   developer.chrome.com/docs/lighthouse.)
3. **The personalized deficit report as the activation moment.** `npm audit`'s
   "found X vulnerabilities" is the culturally-installed report shape; Liquibase's
   Drift Report and Atlas's drift detection sell the same "here is YOUR divergence"
   artifact; HubSpot's Website Grader is the canonical growth case. The framing
   literature adds the mechanism: loss-framing outperforms specifically for
   *detection behaviors* when the message is personally relevant AND carries
   response-efficacy — which maps exactly to "your own git history" + "the gate
   that closes each finding." Evidence + personal relevance do the work, not fear
   copy. (docs.npmjs.com/cli/audit; docs.liquibase.com Drift Report;
   atlasgo.io/monitoring/drift-detection; O'Keefe & Jensen meta-analysis;
   rips-irsp.com/articles/10.5334/irsp.15.)
4. **The report is the distribution channel.** HubSpot's grader earned tens of
   thousands of backlinks from shared scores; Liquibase pitches the drift report as
   the shareable troubleshooting artifact. `fit-assessment.md` is already
   paste-into-an-issue Markdown; the report a dev shows their team is the ad the
   next dev sees. (Optional follow-up, out of scope here: a one-line provenance
   footer in the report contract naming the hosted URL.)
5. **Anti-hype honesty *is* the conversion strategy.** PostHog ("don't trick them
   with hyperbolic tactics"; ungate everything) and the developer-marketing canon
   (swyx: devs ask "what's the catch?") — the copy must pre-answer the trust
   questions: read-only, what it reads, whose tokens it burns, that results vary by
   model, that every claim is checkable. The assessment's built-in honesty
   machinery (NOT-A-FIT verdicts, mandatory "what you will NOT get", the >15%
   false-positive kill criterion) is a *selling point*, not fine print.
   (posthog.com/newsletter/marketing-for-devs; markepear.dev.)

**Anti-patterns to avoid** (all already congruent with this project's doctrine):
gating the report (theater here — it's generated locally); fear copy without
efficacy (every ledger row must name its closing gate — the skill already mandates
this); score/finding-count theater (fewer, cited findings beat many unverifiable
ones); overclaiming determinism (the user's model runs it — disclose variance);
hidden costs (state tokens + read-only up front); fake scarcity (never).

### 1.4 CTA verb — the call

The research verdict on the verb candidates:

| Verb | Dev-culture prior | Fit here |
|---|---|---|
| **audit** | `npm audit`, Lighthouse — read-only pass, evidence-cited findings, severity report. The strongest verb for "examine the record of what already happened." | Strong — but **collides with the shipped post-adoption `metaobjects-audit` skill** (a different product surface: adoption-depth review). Two "audits" meaning two different things is a terminology bug in a project this naming-disciplined. |
| **scan** | Snyk/Socket/Aikido security scanning | Fast but shallow — undersells the git forensics and the decision-grade verdict. |
| **assessment** | AWS Migration Evaluator, Azure Migrate, BigQuery migration assessment — free, pre-decision, produces a plan | Right for the artifact (it IS a fit-and-migration assessment, and the skill/report/URL already carry the name). Slightly slower as a verb. |
| **health check / fit check** | graders; no dev usage ("fit check" is outfit slang) | Vague / avoid. |

**Chosen: "assess" as the CTA verb and `/assess.md` as the path — with the
drift-audit *framing* carried by the headline language, not the name.** The
deciding factors: (a) the shipped skill, report contract, and the fit-assessment
design's hosting section all already say *assessment* — the copy must match what
the artifact actually calls itself when the agent fetches it; (b) "audit" is
already taken by the post-adoption `metaobjects-audit` skill, and the two surfaces
will eventually be seen by the same adopter; (c) the thing "audit" buys —
forensic, read-only, findings-with-receipts — is delivered instead by the
headline copy ("ask your own git history", "finds the drift already biting you"),
where it works harder than a label would. The owner's own word ("audit their
projects") is honored in body copy — the assessment *audits your git history* —
without renaming the surface. (Flagged as open decision #2 if the owner wants to
overrule.)

---

## 2. The mechanism

**The invocation contract is one sentence a human pastes into any coding agent with
their repo open:**

> Fetch https://metaobjects.dev/assess.md and run the MetaObjects Fit & Migration
> Assessment against this repository.

**Hosting.** Serve the prompt itself (not a redirect) as a static file:

- **Primary URL:** `https://metaobjects.dev/assess.md` — add the file
  `www/assess.md` to the site repo (`metaobjectsdev.github.io`), next to `llms.txt`.
  Content: the body of
  `agent-context/skills/metaobjects-fit-assessment/SKILL.md` (front-matter stripped,
  the version-grounding line kept). No redirect infrastructure is needed or wanted:
  the site deploys `www/` verbatim via GitHub Pages `actions/deploy-pages` (no
  Jekyll pass), so a `.md` file is served as-is — and a static file beats a redirect
  because some agent fetch tools follow redirects poorly. Near-term this is a manual
  stamped copy; the Phase-3 assembler flatten step from the fit-assessment design
  takes over regeneration in the release flow.
- **Mirror / works-today fallback:** the raw GitHub URL (live now, HTTP 200,
  `text/plain`, ~30 KB — a single practical fetch):
  `https://raw.githubusercontent.com/metaobjectsdev/metaobjects/main/agent-context/skills/metaobjects-fit-assessment/SKILL.md`
- **Universal no-fetch fallback** (works in every tool, including locked-down
  enterprise setups, and gives verbatim fidelity): save the file anywhere in the
  workspace — `curl -fsSL https://metaobjects.dev/assess.md -o
  metaobjects-assess.md` (don't commit it) — then tell the agent: *"Read
  `metaobjects-assess.md` and run the assessment it contains against this
  repository."* Pasting the file's contents into the chat is the secondary
  fallback.

**Per-tool one-liners** (for docs/support surfaces; the copy blocks below keep to
the universal sentence + a compact tool list — full verification detail in §1.1):

- **Claude Code** — paste the sentence; `WebFetch` fires on its own (one-time
  domain confirmation). Long-prompt fidelity tip: "download the raw file with
  curl, then follow it."
- **Cursor** (agent mode) — paste the URL + instruction; the agent's web tools
  fetch it (fall back to the saved-file route if not).
- **Windsurf** (Cascade) — paste the URL in the message; pasted-URL reads are
  local and ungated.
- **GitHub Copilot** (VS Code) — `#fetch https://metaobjects.dev/assess.md — run
  this assessment against the open workspace.`
- **OpenAI Codex** (CLI) — `codex --search`, then the sentence (or approve the
  `curl` it proposes).
- **Gemini CLI** — the sentence as-is; the built-in `web_fetch` tool handles it.

**Discovery wiring** (same motion as the fit-assessment design §7.3) — add to
`www/llms.txt`, immediately **before** the existing "For AI assistants adopting
MetaObjects" section:

```markdown
## For AI assistants evaluating whether a project should adopt MetaObjects

If you are helping someone decide whether to adopt MetaObjects in an existing
project, fetch <https://metaobjects.dev/assess.md> and follow it against the
repository. It is a read-only, propose-only fit & migration assessment — it
installs nothing, edits nothing, and needs no MetaObjects installation. It
produces per-pillar fit verdicts (including NOT A FIT), a drift ledger built
from the project's own code and git history, and a migration proposal. The
"adopting" section below is the next step after a yes verdict.
```

---

## 3. README block

Two edits to `README.md` (this repo).

**3a — new first bullet in "Quick links":**

```markdown
- Already have a codebase? → Have your coding agent run the
  [fit assessment](#try-it-on-your-repo--nothing-to-install) — read-only, no
  install; it finds the drift already in your git history.
```

**3b — new standalone section, placed immediately after the "Built AI-first"
blockquote and before "Quick links".** (Sequencing: if the README ships before
`www/assess.md` is published on the site, substitute the raw GitHub URL from §2 in
both places it appears below.)

````markdown
## Try it on your repo — nothing to install

MetaObjects ships a hosted **fit & migration assessment**: one Markdown prompt your
coding agent runs against your existing repo. It is **read-only and propose-only** —
it installs nothing, edits nothing, and needs no database connection and no signup.
Your agent reads the code, the migrations, and the git history, then writes a
decision-grade report
(`metaobjects-fit/fit-assessment.md` plus a machine-readable JSON twin).

The centerpiece is a **drift ledger built from your own history**: every shape your
repo declares more than once, whether the copies disagree *today*, the past commits
where a fix patched one copy and missed the other — and, per finding, the `verify`
gate that would have made it a build failure instead of an incident. In a blinded
retro-test on a real pre-adoption production codebase, the assessment surfaced
specific, git-verified drift incidents that had already bitten — including a
CHECK-constraint mismatch repaired only after a production violation, and a schema
divergence still live at assessment time — and its misses ran conservative, not
inflated ([design + retro-test](docs/superpowers/specs/2026-07-12-metaobjects-fit-assessment-design.md)).

With your repo open in your coding agent (Claude Code, Cursor, Windsurf, GitHub
Copilot, Gemini CLI, Codex — anything that can fetch a URL), send one message:

```text
Fetch https://metaobjects.dev/assess.md and run the MetaObjects Fit & Migration
Assessment against this repository.
```

If your agent can't fetch URLs (or you want it to follow the prompt verbatim), save
the file into your workspace instead — `curl -fsSL https://metaobjects.dev/assess.md
-o metaobjects-assess.md` (don't commit it) — and say: *"Read
`metaobjects-assess.md` and run the assessment it contains against this
repository."* The prompt is one Markdown file
([source](agent-context/skills/metaobjects-fit-assessment/SKILL.md)); read it first
if you like — you should never point your agent at a prompt you haven't vetted.

The catch, stated plainly: it runs in **your** agent on **your** tokens (minutes of
agent time, none of yours); findings vary by model and repo size; and every claim is
cited to a `file:line` or a commit precisely so you can check it. Nothing is sent to
us — there is no signup, and the report stays in your repo.

The report is built to say **no**: per-pillar verdicts include `NOT A FIT`, every
capability claim is capped to what your language's port actually ships, and a
"what you will NOT get" section is mandatory. If the verdict is yes, it ends with a
first-week wedge plan — and `meta init` picks up from there.
````

*(Nested fence note: the outer fence above is four backticks so the inner
triple-backtick `text` block survives; paste the section contents as-is into the
README.)*

---

## 4. Homepage (index.html) block

Two edits to `www/index.html` in the site repo.

**4a — a third hero CTA** (inside the existing `hero-ctas` div, after the
"Read the spec" button):

```html
        <a href="#assess" class="btn btn-secondary">Assess your repo — no install</a>
```

**4b — new section, placed immediately after the closing `</section>` of the
drift-table section (`class="drift"`) and before the implementations matrix.** It
reuses only existing classes (`drift`, `section-label`, `drift-intro`,
`example-section-label`, `example-code`, `drift-payoff`):

```html
    <!-- Fit assessment — prove it on your own repo, zero install -->
    <section class="drift" id="assess">
      <h2 class="section-label">Don't take the table's word for it. Ask your own git history.</h2>
      <p class="drift-intro">
        MetaObjects ships a hosted <strong>fit &amp; migration assessment</strong>: one Markdown prompt your coding agent runs against your existing repo. <strong>Read-only, propose-only</strong> — it installs nothing, edits nothing, needs no database connection and no signup. Your agent reads the code, the migrations, and the commit log, then writes a decision-grade report whose centerpiece is a <strong>drift ledger built from your own history</strong>: the shapes you declare twice, where the copies disagree <em>today</em>, the past fixes that patched one copy and missed the other — and, per finding, the <code>verify</code> gate that would have made it a build failure instead of an incident.
      </p>
      <p class="example-section-label">With your repo open in your agent, send one message — read-only · no install · no signup</p>
      <pre class="example-code"><code>Fetch https://metaobjects.dev/assess.md and run the MetaObjects
Fit &amp; Migration Assessment against this repository.</code></pre>
      <p class="drift-intro">
        Works in Claude Code, Cursor, Windsurf, GitHub Copilot, Gemini CLI — any agent that can fetch a URL. No agent open right now? <a href="/assess.md">Read the assessment prompt</a> — it's one Markdown file; pasting it into any chat works too. The catch, stated plainly: it runs in your agent on your tokens, findings vary by model, and every claim is cited to a <code>file:line</code> or a commit precisely so you can check it. Nothing is sent to us; the report stays in your repo.
      </p>
      <p class="drift-payoff">
        <strong>It's built to say no.</strong> Per-pillar verdicts include <em>NOT A FIT</em>, every promise is capped to what your language's port actually ships, and a "what you will NOT get" section is mandatory. In a blinded retro-test on a real pre-adoption production codebase, the assessment found specific, git-verified drift incidents that had already bitten — a constraint mismatch repaired only after a production violation, a schema divergence still live at assessment time — and its errors ran conservative, not inflated.
      </p>
    </section>
```

---

## 5. getting-started.html change

New section inserted in `www/getting-started.html` **immediately after the closing
`</section>` of the hero and before "1 · Install &amp; scaffold"** — the
existing-project reader's first step becomes "assess it first" (the
assess → wedge → adopt path), and the greenfield reader is explicitly waved past.
Reuses only existing classes (`section-label`, `gs-note`, `gs-say` — whose CSS
`::before` renders the "You → Claude Code:" prefix):

```html
    <section>
      <h2 class="section-label">0 · Already have an app? Assess it first — nothing to install</h2>
      <p class="gs-note">Adopting into an existing codebase? Before you install anything, have your agent run the
        <strong>fit &amp; migration assessment</strong> against your repo. It's read-only and propose-only — it reads
        your code, migrations, and git history, and writes a decision-grade report: per-pillar fit verdicts (including
        <em>NOT A FIT</em>), a drift ledger of the shapes you already declare twice — with the past commits where a fix
        patched one copy and missed the other — and, if the verdict is yes, a first-week wedge plan.</p>
      <p class="gs-say">Fetch https://metaobjects.dev/assess.md and run the MetaObjects Fit &amp; Migration Assessment against this repository.</p>
      <p class="gs-note">Any agent that can fetch a URL works (Claude Code, Cursor, Windsurf, Copilot's
        <code>#fetch</code>, Gemini CLI). Locked-down agent? Save <a href="/assess.md">the prompt file</a> into your
        workspace and tell the agent to read it — every agent reads workspace files. The report ends where this page
        begins: its wedge plan's first command is <code>meta init</code>, step 1 below. Greenfield project? Skip
        straight to step 1.</p>
    </section>
```

*(The numbered circles on this page are CSS counters scoped to `.gs-steps`; this
section deliberately uses a plain heading — "0 ·" in the text — so the existing
step numbering is untouched.)*

---

## 6. Video

**Recommendation: a new 60–90 s short, not a re-render of video 3.** Video 3
("Adopt an existing app — one table at a time") is the *wedge motion* — it already
survived the honesty re-render and its story is complete. The assessment is the
step *before* the wedge (decide → wedge → adopt), aimed at a different moment
(pre-decision), and a standalone short is the directly shareable acquisition asset.
On `videos.html` the new section slots **between "Getting started" and "Adopt an
existing app"** (pre-adoption order), and video 3's blurb gains one pointer
sentence: *"Not sure it's worth adopting? Run the <a href="#assess-repo">fit
assessment</a> first — it's read-only and finds the drift already in your
history."*

> **Rendering is a follow-up on the owner's voice pipeline — this doc ships the
> script only.** Production note: all demo footage must use a public/demo
> repository (never the private Phase-0 target); the quoted incident numbers come
> from the published retro-test writeup in this repo and are cited as "a real
> production codebase," never named.

### Script — "Assess your repo: find the drift you already shipped" (~80 s)

On-screen headings are full-sentence assertions (assertion-evidence style); wit
lives in the narration only.

| # | Time | On-screen heading (assertion) | Screen | Narration |
|---|---|---|---|---|
| 1 | 0:00–0:07 | **Your repo has already drifted — and your git history has the receipts.** | A `git log --oneline` scrolling; a commit subject like `fix: sync status constraint with entity` highlighted. | Somewhere in your repo, one shape is declared twice. And your git history remembers the day the copies disagreed. |
| 2 | 0:07–0:16 | **One pasted message runs a read-only assessment. Nothing is installed.** | Claude Code open on a demo repo; the one-liner ("Fetch https://metaobjects.dev/assess.md …") pasted and sent. | Open your repo in your coding agent — Claude Code, Cursor, Copilot, whatever you run — and paste one message. Nothing installs. Nothing is edited. No database connection. |
| 3 | 0:16–0:30 | **The agent reads your code, your migrations, and your history — and cites every claim.** | Agent tool calls scrolling: reading migration files, grepping validators, `git log -S`. | Your agent reads the code, the migrations, and the commit log, and builds a drift ledger. Every row cites a file and line, or a commit. No vibes. |
| 4 | 0:30–0:48 | **In a real pre-adoption codebase, it found drift that had already reached production.** | Rendered ledger rows (genericized): "enum vs CHECK constraint — repaired after a production violation" / "column width: annotation 64, live DB 255 — divergent today" / "one new field → 28 files". | In a blinded test on a real production codebase, it found an enum constraint that had drifted across a hundred and forty-six migrations — repaired only after production errors. A column the database had widened seven weeks earlier that the code still didn't know about. And a single new field that took twenty-eight file edits to land. |
| 5 | 0:48–1:02 | **Every finding names the gate that would have caught it.** | The gate-mapping table: duplicates → `verify --codegen`; schema vs model → `verify --db`; prompts → `verify --templates`. | Each finding names the verify gate that turns it into a build failure instead of an incident. That's the pitch — not "it might drift." It already did. Here's the gate. |
| 6 | 1:02–1:15 | **It is built to say no — verdicts include NOT A FIT, and limits are mandatory.** | The report's verdict block: per-pillar verdicts; the "What you will NOT get" heading visible. | And it's built to say no. Verdicts include "not a fit," and every report ships a "what you will not get" section. If the answer is yes, you get a first-week wedge plan. |
| 7 | 1:15–1:25 | **metaobjects.dev/assess.md — one URL. Your agent does the reading.** | The URL + the one-liner, static end card. | One URL — metaobjects dot dev, slash, assess dot em-dee. Point your agent at it. Worst case, you learn your repo is fine. Best case, you stop shipping the same bug twice. |

### videos.html section (ready for when the video is rendered)

Matches the file's existing inline-style conventions; id `assess-repo`:

```html
    <!-- Assess your repo -->
    <section class="video-section" id="assess-repo" style="max-width:900px;margin:0 auto;padding:2.5rem 1.5rem 0;">
      <h2 class="section-label">Assess your repo — find the drift you already shipped</h2>
      <p style="color:#8b9ab5;max-width:720px;">
        Before you adopt anything: paste one message into your coding agent and it runs a read-only fit assessment
        against your repo — including a drift ledger mined from your own git history. Nothing installed, nothing edited.
      </p>
      <figure style="margin:0;">
        <video controls preload="metadata" playsinline
               poster="/video/assess-repo-poster.png"
               width="1280" height="720"
               aria-label="Assess your repo: a coding agent runs the read-only MetaObjects fit assessment and finds git-verified drift incidents."
               style="width:100%;max-width:860px;height:auto;border-radius:14px;border:1px solid rgba(255,255,255,0.08);margin:1rem auto 0;display:block;">
          <source src="https://metaobjects.com/video/assess-repo.mp4" type="video/mp4">
          <track kind="captions" src="/video/assess-repo.vtt" srclang="en" label="English">
          Your browser doesn't support embedded video — <a href="https://metaobjects.com/video/assess-repo.mp4">download the assess-your-repo video</a>.
        </video>
      </figure>
    </section>
```

---

## 7. metaobjects.com (exec site) — light placement

**Recommendation: one sentence, no new section.** The exec site is deliberately
jargon-free and version-agnostic; "paste a prompt into your coding agent" is a
developer motion. But the *business* meaning — proof before commitment, run by your
own team, inside your own tooling — is exec-legible and worth one line.

Add to `src/index.njk`, at the end of the "Why MetaObjects, why now" thesis block
(after the closing paragraph of `div.thesis`, inside the section):

```html
      <p class="section-subtitle" style="margin-top:1.5rem;">
        Not sure it fits your systems? Your engineering team can run a free, read-only
        fit assessment against your own codebase — inside your own AI tooling, nothing
        installed, nothing shared with us — and get an honest report, including
        "not a fit" when that's the answer.
        <a href="https://metaobjects.dev/#assess" target="_blank" rel="noopener">How to run it →</a>
      </p>
```

If the owner prefers zero placement here, skipping this entirely is fine — the
developer surfaces carry the flow.

---

## 8. Open decisions for the owner

1. **Publish gate vs. publish now.** The fit-assessment design names the Phase-2
   holdout run (Adopter-B baseline + negative controls, scored untuned) as **the
   publish gate for `assess.md`**. Phase 0 was a strong go and the raw GitHub URL
   is already technically public, but shipping this copy *promotes* the URL.
   Owner's call: (a) run Phase 2 first (consistent with the design; recommended),
   or (b) consciously waive the gate and ship on Phase-0 evidence, accepting the
   documented risk. This doc's copy is gate-neutral — it quotes only Phase-0
   results that are already published in this repo.
2. **Served-path name:** `/assess.md` (recommended — matches the skill's
   consultative framing and the fit-assessment design §7.2) vs `/audit.md` (the
   owner's own word, but it collides with the *post*-adoption `metaobjects-audit`
   skill) vs `/drift.md`. See the CTA-verb rationale in §1.
3. **Optional human landing page** at `/assess/` (a small HTML page showing the
   one-liner + per-tool notes + a link to the raw prompt) in addition to the
   `.md` file. Nice-to-have; the `.md` alone is sufficient and is what agents fetch.
4. **Site-file maintenance:** manual stamped copy of `SKILL.md` → `www/assess.md`
   now, superseded by the Phase-3 assembler flatten step in the release flow
   (recommended), or wait for the assembler before publishing the site path (the
   raw GitHub URL carries the interim).
5. **Record the video now or after Phase 2** (same gate logic as decision 1; the
   script is ready either way, and rendering rides the owner's voice pipeline).
6. **Hero CTA button** (§4a): add the third button, or keep the homepage change
   section-only to preserve the current two-button hero.
7. **metaobjects.com one-liner** (§7): include or skip.
