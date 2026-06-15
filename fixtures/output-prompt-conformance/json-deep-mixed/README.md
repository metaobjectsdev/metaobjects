# json-deep-mixed

A large, realistic **request VO** four levels deep that mixes every nesting shape
in one spec — the cross-port gate for deep prompt-payload rendering:

- **singular nested objects** 4 levels deep: `payload.author.contact.{email,verified}`
- an **array of objects**: `payload.sections[]` with `heading` + `priority`
- a nested **enum** (`priority`: `LOW | HIGH`) and a **boolean** (`verified`)
- an **optional** field carrying an example (`payload.summary`) so the whole thing
  still round-trips.

Exercises: guide dotted-path recursion at depth (`payload.author.contact.email`,
`payload.sections[].priority`), indentation at four levels, unquoted boolean
example (`true`), enum `one of …` (guide) / `LOW | HIGH` (inline), and JSON
array-of-objects rendered as `[ one element ]`. `roundTrip: true` — every field
carries a real example, so `extract(exampleOnly)` reads the whole graph back with
no MALFORMED / LOST_* states.
