# template.output render-helper conformance corpus

Cross-port oracle for the `template.output` **render-helper** generator
(`render<Name>(payload, provider)`). Every port (TS, Java today; C#, Python,
Kotlin to follow) must generate render helpers from this exact metadata + the
exact `templates/` here and produce the outputs pinned below — byte for byte.

The provider resolves a 2-layer logical reference `group/source` to
`<templates>/group/source.mustache`. So `@textRef="pages/welcome"` resolves to
`templates/pages/welcome.mustache`, `@subjectRef="emails/welcome.subject"`
resolves to `templates/emails/welcome.subject.mustache`, and so on.

## Files

- `meta.json` — the metadata: a payload value-object `Welcome { name: string }`
  plus two `template.output` nodes over it:
  - `WelcomePage` — `@kind=document`, `@format=html`, `@textRef="pages/welcome"`,
    `@payloadRef=Welcome`. Generates `renderWelcomePage(payload, provider): string`.
  - `WelcomeEmail` — `@kind=email`, `@subjectRef="emails/welcome.subject"`,
    `@htmlBodyRef="emails/welcome.html"`, `@textBodyRef="emails/welcome.txt"`,
    `@payloadRef=Welcome`. Generates `renderWelcomeEmail(payload, provider): EmailDocument`.
- `templates/pages/welcome.mustache` = `Hello {{name}}`
- `templates/emails/welcome.subject.mustache` = `Welcome {{name}}`
- `templates/emails/welcome.html.mustache` = `<p>Hi {{name}}</p>`
- `templates/emails/welcome.txt.mustache` = `Hi {{name}}`
- `nested/meta.json` — a **no-package** sub-corpus carrying the nested/array
  email case (`Order` over `Customer` + `Item[]`); see "Nested + array email"
  below. It shares the same `templates/` dir.
- `templates/emails/order.subject.mustache` = `Order for {{customer.name}}`
- `templates/emails/order.html.mustache` =
  `<h1>{{customer.name}}</h1><ul>{{#items}}<li>{{sku}} x{{qty}}</li>{{/items}}</ul>{{> shared/footer}}`
- `templates/emails/order.txt.mustache` =
  `Order for {{customer.name}}:{{#items}} {{sku}} x{{qty}};{{/items}}`
- `templates/shared/footer.mustache` = `<hr/>Sent by Acme` (a partial reused by
  the order html body).
- `drift/` — the build-time drift case (see below).

(None of the `.mustache` files carry a trailing newline, so the rendered output
has none either.)

## Expected outputs — payload `{ name: "Ada" }`

| template      | kind     | call                                  | expected result |
| ------------- | -------- | ------------------------------------- | --------------- |
| `WelcomePage`  | document | `renderWelcomePage({name:"Ada"}, p)`   | `"Hello Ada"`   |
| `WelcomeEmail` | email    | `renderWelcomeEmail({name:"Ada"}, p)`  | `EmailDocument` below |

`EmailDocument` for `WelcomeEmail`:

- `subject`  = `"Welcome Ada"`
- `htmlBody` = `"<p>Hi Ada</p>"`
- `textBody` = `"Hi Ada"`

(`name` carries no HTML-special characters, so the `html`-format html body is
identical to its text source after interpolation.)

## Email HTML safety — payload `{ name: "<b>A & Co</b>" }`

Renders the SAME `WelcomeEmail` with a markup/XSS-bearing name, proving the
`@format=html` part escapes while the `@format=text` parts stay raw. The engine
owns escaping (Mustache's own HTML-escaping is disabled); the `html` escaper is
the XML entity set (`<`→`&lt;`, `>`→`&gt;`, `&`→`&amp;`, `"`→`&quot;`, `'`→`&#39;`).

- `subject`  (text) = `"Welcome <b>A & Co</b>"` — RAW
- `htmlBody` (html) = `"<p>Hi &lt;b&gt;A &amp; Co&lt;/b&gt;</p>"` — ESCAPED
  (no raw `<b>` reaches a mail client)
- `textBody` (text) = `"Hi <b>A & Co</b>"` — RAW

## Nested + array email — `nested/meta.json`, `OrderEmail`

`nested/meta.json` is a **no-package** sub-corpus: payload VOs
`Customer { name: string }`, `Item { sku: string, qty: int }`, and
`Order { customer: Customer (field.object @objectRef), items: Item[] (field.object
@objectRef, isArray) }`, plus an `email` template `OrderEmail`
(`@payloadRef=Order`) over the `order.*` part-refs. It has **no package** on
purpose: a bare `@objectRef` resolves identically across ports only when there is
no package (TS resolves an objectRef by short name; the JVM expands a *packaged*
ref to an FQN, so bare == FQN only at the root package). The shared
`templates/emails/order.*` + `templates/shared/footer` mustaches are reused.

Rendered with `{ customer: { name: "Ada" }, items: [ { sku: "A1", qty: 2 },
{ sku: "B2", qty: 1 } ] }`:

- `subject`  (text) = `"Order for Ada"`
- `htmlBody` (html) =
  `"<h1>Ada</h1><ul><li>A1 x2</li><li>B2 x1</li></ul><hr/>Sent by Acme"`
  (the `{{#items}}` loop expands both items; the `{{> shared/footer}}` partial
  resolves and is appended)
- `textBody` (text) = `"Order for Ada: A1 x2; B2 x1;"`

(No value carries HTML-special characters, so the `html` body is unescaped after
interpolation; the items/customer payload is plain.) The clean nested template
passes the BUILD-TIME drift gate — and a `{{#items}}{{bogus}}{{/items}}`
section-context drift (a `{{bogus}}` not on the `Item` element type the section
pushes) FAILS codegen with `ERR_VAR_NOT_ON_PAYLOAD`, proving the gate walks the
nested/section context, not just the root.

## Expected build-time drift FAILURE — `drift/`

`drift/meta.json` declares the same `Welcome` VO and a `document`
`template.output` `WelcomePage` whose `@textRef="pages/bad"` resolves to
`drift/templates/pages/bad.mustache` = `Hi {{missing}}`. `{{missing}}` is **not**
a field on the `Welcome` payload VO.

Generating the render helper for this case MUST **fail codegen** (throw) with the
error code `ERR_VAR_NOT_ON_PAYLOAD`, and the message must name the offending
field (`missing`), the template (`WelcomePage`), and the ref (`pages/bad`). This
is the build-time gate that stops a template from drifting away from its payload
contract.
