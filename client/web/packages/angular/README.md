# @metaobjectsdev/angular

Angular 18 runtime for metaobjects: `EntityFetcherToken` injection token, `<mo-currency-input>` standalone component, `<mo-entity-grid>` standalone component (TanStack Angular Table 8.x), and a DI-friendly cell-renderer registry. Pairs with `@metaobjectsdev/codegen-ts-angular`, which generates `<Entity>.service.ts`, `<Entity>.form.component.ts`, and `<Entity>.grid.component.ts` files that import from this package.

Universal browser client — works with any backend that conforms to the cross-port REST contract (TS / Java / Kotlin / C# / Python).

## Install

> **NOT published to npm — source-only by decision**
> ([ADR-0048](../../../../spec/decisions/ADR-0048-angular-tier-source-only.md)).
> This package builds in-repo on its own `0.6.x` line, but has never been released —
> `npm i @metaobjectsdev/angular` returns a 404, and that is deliberate: the tier is
> not yet at the published tier's bar (grid parity with TanStack, view-kind form
> dispatch, a runner that can execute its behavioral suite — the full promotion
> checklist lives in the ADR). Consume it from source (a workspace/file dependency,
> or `npm pack` + install the tarball) by building from this directory. The
> published browser-client tier is React + TanStack; see
> [`docs/ports/typescript-client.md`](../../../../docs/ports/typescript-client.md). To
> build locally you'll want these as workspace deps: `@angular/core@^18`,
> `@angular/forms@^18`, `@angular/common@^18`, `@tanstack/angular-table@^8`.
> Angular 18 is the only tested major — the peer ranges say so on purpose.

## Wiring

```ts
// app.config.ts
import { ApplicationConfig } from "@angular/core";
import { provideEntityFetcher } from "@metaobjectsdev/angular";

const fetcher = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, { ...init, credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
};

export const appConfig: ApplicationConfig = {
  providers: [provideEntityFetcher({ fetcher, baseUrl: "/api" })],
};
```

## License

Apache-2.0.
