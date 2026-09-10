# `metaobjects-codegen-kotlin` — known gaps

**The gap list for this module lives beside the generators**, at
[`src/main/kotlin/com/metaobjects/generator/kotlin/KNOWN_GAPS.md`](src/main/kotlin/com/metaobjects/generator/kotlin/KNOWN_GAPS.md)
— the same position `codegen-spring` keeps its own file in, and the one corrections
actually land in.

This file used to carry a second, differently-structured gap list of its own (#361). The two
were not copies: each documented gaps the other did not, so the risk was never a stale
duplicate but a reader finding one list at the module root and believing it was the list.
Both sets now live in the canonical file; this page is a pointer so that reader lands there.
