# @metaobjectsdev/angular

Angular 18 runtime for metaobjects: `EntityFetcherToken` injection token, `<mo-currency-input>` standalone component, `<mo-entity-grid>` standalone component (TanStack Angular Table 8.x), and a DI-friendly cell-renderer registry. Pairs with `@metaobjectsdev/codegen-ts-angular`, which generates `<Entity>.service.ts`, `<Entity>.form.component.ts`, and `<Entity>.grid.component.ts` files that import from this package.

Universal browser client — works with any backend that conforms to the cross-port REST contract (TS / Java / Kotlin / C# / Python).

## Install

```bash
pnpm add @metaobjectsdev/angular @angular/core@^18 @angular/forms@^18 @angular/common@^18 @tanstack/angular-table@^8
```

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
  providers: [provideEntityFetcher(fetcher)],
};
```

## License

Apache-2.0.
