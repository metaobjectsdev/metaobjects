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
- `xpkg-collision/` — a **multi-package** sub-corpus (`meta.alpha.json` +
  `meta.beta.json` + `meta.app.json`) gating **FQN-exact** nested `@objectRef`
  resolution across a cross-package short-name collision (ADR-0041) AND the
  collision-aware payload-record naming contract (ADR-0044); see
  "Cross-package short-name collision" below. It also shares `templates/`.
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
no package: a bare `@objectRef` matches the value-object's short name in every
port, so this sub-corpus isolates the nested/array/partial shape from any
package-resolution concern. (The *packaged*/fully-qualified `@objectRef` case is
gated separately by `xpkg-collision/` below, per ADR-0041.) The shared
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

## Cross-package short-name collision — `xpkg-collision/`, `DigestDoc`

A **multi-package** sub-corpus (loaded as three sources — `meta.alpha.json` +
`meta.beta.json` + `meta.app.json`, mirroring
`fixtures/conformance/loader-same-name-distinct-packages`) that gates **FQN-exact**
nested `@objectRef` resolution (ADR-0041):

- `acme::alpha` declares `object.value Note { alphaText: string }`.
- `acme::beta` declares `object.value Note { betaText: string }` — a **colliding
  short name** in a different package.
- `acme::app` declares payload `object.value Digest` with two `field.object`
  children referencing the two Notes by **fully-qualified** `@objectRef`
  (`acme::alpha::Note`, `acme::beta::Note`), and a `document` `template.output`
  `DigestDoc` (`@format=html`, `@textRef="xpkg/digest"`, `@payloadRef="Digest"`).
- `templates/xpkg/digest.mustache` = `Alpha={{fromAlpha.alphaText}} Beta={{fromBeta.betaText}}`

Each port must resolve a fully-qualified `@objectRef` **exactly** on the
package-qualified name — never a bare-tail fallback that binds whichever `Note`
loads first. A bare-tail resolver collapses BOTH refs to one package's `Note`, so
one of `{{fromAlpha.alphaText}}`/`{{fromBeta.betaText}}` lands on the wrong element
type and the build-time drift gate throws `ERR_VAR_NOT_ON_PAYLOAD`. FQN-exact
resolution binds each ref to its own package, so the clean template passes.

Rendered with `{ fromAlpha: { alphaText: "AA" }, fromBeta: { betaText: "BB" } }`:

- `renderDigestDoc(...)` = `"Alpha=AA Beta=BB"`

### Payload-record naming contract (ADR-0044)

The two colliding VOs share the BARE short name `Note`. [ADR-0044](../../spec/decisions/ADR-0044-payload-record-naming-cross-package-collision.md)
is the binding contract for what each port's payload emitter must do about that —
this sub-corpus is the executable oracle for it, in addition to gating the
`@objectRef` **resolver** above:

1. **Payload records/types/interfaces used by a port's conformance runner MUST be
   GENERATOR-emitted — hand-authoring (or any other manual reconciliation) is
   PROHIBITED.** A hand-written merged record (`{ alphaText?; betaText? }`, both
   optional, both shapes folded into one) is exactly the silently-wrong-adjacent
   shape ADR-0044 rejects: it erases `@required` and lets a typo against either
   real shape type-check. Construct the render-time payload instance from the
   port's REAL generated payload type(s) for this fixture.
2. **Naming rule:** a value-object whose bare short name is unique within the
   emitted artifact's `@objectRef` closure emits bare, in the port's existing
   convention; a value-object whose bare short name COLLIDES with another
   closure member emits under its package-qualified derived name — PascalCase
   each `::`-segment of its package, concatenate, append the bare short name,
   then apply the port's suffix convention. A still-colliding derived name is a
   hard generator error, `ERR_PAYLOAD_NAME_COLLISION`.
3. **Expected emitted names for this fixture, per port** (`Digest` itself does
   not collide and stays bare in every port):

   | Port | `acme::alpha::Note` | `acme::beta::Note` |
   |---|---|---|
   | TypeScript (`interface`) | `AcmeAlphaNote` | `AcmeBetaNote` |
   | C# (`record`) | `AcmeAlphaNote` | `AcmeBetaNote` |
   | Java / Kotlin (`record`/data class) | `AcmeAlphaNotePayload` | `AcmeBetaNotePayload` |
   | Python (`class`) | `AcmeAlphaNotePayload` | `AcmeBetaNotePayload` |

The render-output pins above (`"Alpha=AA Beta=BB"`) are UNCHANGED by this contract
— the render engine and the build-time verify field-tree resolve against
**metadata**, never against record names. Payload-record *source* stays per-port
idiomatic (Tier-1 codegen); this sub-corpus gates it by compile + construct +
render + name assertions, strengthening the gate rather than weakening it.

## Cross-package short-name collision with extract/output-parser tier — `xpkg-collision-json/`

Identical to `xpkg-collision/` above (same three metadata files, same `Digest`
payload with colliding `Note` VOs from `acme::alpha` and `acme::beta`), but the
`DigestDoc` `template.output` has `@format="json"` instead of `@format="html"`.
This variant exercises the extract/output-parser tier (which gates on
`@format ∈ {json,xml}`); the html variant does not. The generated render helper,
collision-aware payload naming, and render output remain identical — see
[Cross-package short-name collision](#cross-package-short-name-collision--xpkg-collision-digestdoc)
above for the full contract and expected payload names
(`AcmeAlphaNotePayload`/`AcmeBetaNotePayload` for Java/Kotlin/Python;
`AcmeAlphaNote`/`AcmeBetaNote` for TS/C#).

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
