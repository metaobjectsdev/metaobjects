# Fit assessment — maintainer notes

Notes for maintainers of `agent-context/skills/metaobjects-fit-assessment/`. They are not part of the
assessment prompt, which is why they live here and not in `SKILL.md`. The design and retro-test
validation are in [2026-07-12-metaobjects-fit-assessment-design.md](2026-07-12-metaobjects-fit-assessment-design.md).

## Not scaffolded, and how the hosted form is built

`scaffold: false` sits under `metadata:` in the skill's front-matter and is a human marker only: no
code reads it. The skill is excluded from `meta init` because it is absent from the SDK's
`SKILL_NAMES`.

The skill splits its capability sheet and its JSON contract into `references/`, under the 500-line
limit for a skill body. The hosted prompt (`https://metaobjects.dev/assess.md`) must still be one
file, so `node scripts/build-assess-prompt.mjs` writes it: it drops the front-matter, the
skill-form-only reference table and any text above the first top-level heading, and replaces each
`<!-- inline: references/<file>.md -->` line with that file's body. The site deploy uses that output;
`scripts/test-build-assess-prompt.mjs` gates it.

## Notes carried over from the skill file

NOT SCAFFOLDED. This is a PRE-adoption tool, so it is deliberately absent from the
SDK's `SKILL_NAMES` (`server/typescript/packages/sdk/src/agent-context/types.js`) and
is never emitted by `meta init` — a target that has not adopted MetaObjects has no
`.claude/skills/metaobjects-*` to drop it into. This directory is its single source of
truth. Its sibling is `metaobjects-audit` (POST-adoption; scaffolded). Design +
retro-test validation: `docs/superpowers/specs/2026-07-12-metaobjects-fit-assessment-design.md`.
How to run it: point a high-end LLM at a target repo + this file (e.g. paste it, or
fetch it from GitHub / metaobjects.dev) and let it produce the report below.

DEFERRED, ON PURPOSE — capability requirements (`requirement.functional` /
`requirement.architectural`). This skill deliberately says NOTHING about them, and that is a
decision, not an omission.

Why not now: (1) SPENT -- this read "not in a release yet", and it is now. `requirement.*`
shipped in 0.22.0 and has evolved twice since (0.23.0 added `planned` / `@disposition` /
`@trackedBy`; 0.24.0 made the vocabulary prescriptive-only). Do not repeat this reason.
(2) The signal->feature mapping is unvalidated against this skill's own kill criterion: the
controlled evidence (0/24 model-only revivals) measures POST-adoption model-reading, and the
feature's premise -- that the disproof lives nowhere in the model -- cuts against pre-adoption
detectability. If the reasoning was never written down, there is nothing for an evidence-cited
assessment to cite. (3) Whether anyone fills the ledger in is itself untested; advertising it pre-adoption
is the brochure failure this skill exists to avoid.

TRIGGER to revisit — the release carrying `requirement.*` has shipped, AND either:
  Arm A  a dogfooded project's retired capabilities are shown, retrospectively,
         to have been discoverable PRE-adoption from repo evidence at file:line standard
         (removal commit, dead flag, do-not-reintroduce comment);
  Arm B  a team that adopted via this assessment hits a resurrection the ledger would have
         caught, or asks why the assessment never mentioned it.

ARM A HAS FIRED (dogfooded adopter estate, 2026-08-13). Three retired or reversed capability
decisions were each citable PRE-adoption at file:line -- a removal commit, two explicit
do-not-reintroduce comments on the very constant an agent would revive, an .env.example line
saying the knob does not exist. The ANTI-TRIGGER did NOT fire: every one traced to committed
prose. Bound it honestly -- n=1, and that estate is unusually disciplined about recording
reversals in co-located prose, which is precisely the manual work `requirement.*` systematizes,
so it is a confound rather than a clean sample. It also partly falsifies the feature's own
premise that the disproof lives nowhere in the model.

SO THE DEFERRAL NOW RESTS ON (3) ALONE, which makes it a judgement about VALUE rather than a
fact about the release. Unprompted uptake is still unmeasured, and a later cross-estate reading
sharpened the question: ledger value tracks whether the ledger is EXECUTABLE -- whether some
mechanism can falsify a claim -- not when it was written. The largest ledger measured carried
no harness and produced no defect found by any mechanism. Advertising that to a team that will
hand-maintain it is the brochure failure this skill exists to avoid. Revisiting means deciding
the SHAPE below is worth spending, not re-checking whether the capability exists.

ANTI-TRIGGER (defer -> never): if dogfooded entries trace only to tribal knowledge with no
repo artifact, this assessment structurally cannot speak to the feature as a finding.

SHAPE, pre-committed so it is not re-litigated as new machinery: ONE P7 hunt line in the
existing grammar (observable signal -> vocabulary + metadata_sketch), gated like every other
P7 line by "if a hunt line has hits, it must appear" -- so a repo with no retirement scar
tissue produces zero requirements content. NOT a fifth pillar, NOT a P4 rubric row, NOT an
R0 verdict line: no verdict may turn on it.
