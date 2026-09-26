# json-scalars-no-example

JSON number / boolean fields (DOUBLE, INT, LONG, BOOLEAN, an INT array) with NO `@example`
and NO `@instruction`, beside a plain STRING.

The placeholder a non-string field falls back to is emitted **unquoted**
(`"averageRating": {averageRating}`), and so is its inline hint (`"resolved": true | false`,
`"confidence": {Integer 1-5.}` in `json-scalars`). A quoted placeholder taught the model to
answer a number as a JSON string (`"averageRating": "4.5"`), which the generated response
parser then rejected (`expected number, received string`). Only a STRING or ENUM value is
shown in quotes. XML has no quoting and is unaffected.

`roundTrip: false` — the skeleton is a template of placeholders, not an extractable answer.
