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
