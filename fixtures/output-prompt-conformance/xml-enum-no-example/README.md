# xml-enum-no-example

The XML twin of `json-enum-no-example`: an enum with NO `@example` renders as its allowed
members (`<urgency>low | medium | high</urgency>`) in every style, rather than a pre-filled
first member that a model copies. A declared `@example` still wins (see `xml-enum`).

`roundTrip: false` — the skeleton is a template of placeholders, not an extractable answer.
