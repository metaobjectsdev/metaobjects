# json-enum-no-example

A JSON enum with NO `@example`, beside a plain STRING and a BOOLEAN that carry none either.

With no declared example, the skeleton shows an enum as its **allowed members**
(`"urgency": "low | medium | high"`) — the same spelling the `inline` style uses — in
`guide` and `exampleOnly` alike. It used to pre-fill the FIRST member
(`"urgency": "low"`), and a model shown a filled-in value copies it: every reply came back
`low`. An author who wants a concrete value in the skeleton declares `@example` (see
`json-enum`), which still wins.

`roundTrip: false` — the skeleton is a template of placeholders, not an extractable answer.
