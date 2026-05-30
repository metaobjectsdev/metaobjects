# json-nested

JSON with a nested OBJECT field. The FR-010 renderer does NOT expand nested
objects — it emits a flat `"{name}"` placeholder (a documented bounded deferral
that mirrors Java/C#). This case pins that placeholder behavior byte-identically
across ports. `roundTrip: false` — a flat placeholder is not a recoverable nested
object; nested *recovery* is covered by the recover-conformance corpus instead.
