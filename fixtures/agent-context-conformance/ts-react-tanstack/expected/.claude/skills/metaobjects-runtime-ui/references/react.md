# React web client

`@metaobjectsdev/react` is the browser-side React runtime. It is **universal** — it
consumes any backend (TS / Java / Kotlin / C# / Python) that speaks the cross-port
REST contract, not just a TS server. It pairs with the `codegen-ts-react`
`formFile()` generator, which emits `<Entity>.form.tsx` files that import from this
package.

## Install

```bash
npm install @metaobjectsdev/react @metaobjectsdev/runtime-web
npm install --save-dev @metaobjectsdev/codegen-ts-react
```

`@metaobjectsdev/react` peer-deps on `react`, `react-hook-form`,
`@hookform/resolvers`, and `zod`.

## Key exports

| Export | Purpose |
|---|---|
| `useEntityForm(Entity, InsertSchema)` | React Hook Form bound to a generated Zod insert schema; returns the full `UseFormReturn<T>` plus a `.input.<field>` accessor |
| `<CurrencyInput>` | controlled bidirectional money input — strips symbol/grouping on focus, re-formats on blur, emits integer minor units (cents) to `onChange` |

## Generated forms (`formFile()`)

Wire `formFile()` in `metaobjects.config.ts` and `meta gen` emits a
`<Entity>.form.tsx` per entity. The form spreads `.input.<field>` onto each
control; every metadata-derived attribute (placeholder, type, aria-label, RHF
validation rule) rides along automatically:

```ts
// metaobjects.config.ts
import { defineConfig } from "@metaobjectsdev/cli";
// Owned generators scaffolded by `meta init` (ADR-0034 scaffold-and-own).
import { entityFile } from "./codegen/generators/entity";
import { queriesFile } from "./codegen/generators/queries";
import { barrel } from "./codegen/generators/barrel";
import { formFile } from "@metaobjectsdev/codegen-ts-react";

export default defineConfig({
  outDir: "src/generated",
  apiPrefix: "/api",
  generators: [entityFile(), queriesFile(), barrel(), formFile()],
});
```

```tsx
// generated/Author.form.tsx (consumer's view)
import { useEntityForm } from "@metaobjectsdev/react";
import { Author, AuthorInsertSchema } from "./Author";

export function AuthorForm({ onSubmit }: { onSubmit: (v: AuthorInsert) => void }) {
  const form = useEntityForm(Author, AuthorInsertSchema);
  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <input {...form.input.name} />
      <textarea {...form.input.bio} />
      <button type="submit">Save</button>
    </form>
  );
}
```

Validation runs through `zodResolver` against the generated `AuthorInsertSchema`.
`handleSubmit`, `formState`, `setValue`, etc. are all available since the hook
returns the full RHF surface.

## Currency input

`field.currency` stores + transmits integer minor units; the browser formats.
`<CurrencyInput>` keeps editing native (cents in, cents out); `formatCurrency`
(from `@metaobjectsdev/runtime-web`) is the display side.

```tsx
import { formatCurrency } from "@metaobjectsdev/runtime-web";
import { CurrencyInput } from "@metaobjectsdev/react";

formatCurrency(1599, "USD", "en-US");   // "$15.99"
<CurrencyInput value={1599} onChange={setCents} currency="USD" locale="en-US" />
```

## Talking to the backend

React forms submit through whatever data layer you wire. For list/query + mutation
hooks against the REST contract, add the TanStack client
(`@metaobjectsdev/tanstack` + `codegen-ts-tanstack`) — see `tanstack.md`. Both sit
on the single `EntityFetcher` seam your app supplies at its root.
