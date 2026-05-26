import { InjectionToken, type Provider } from "@angular/core";
import type { EntityFetcher } from "@metaobjectsdev/runtime-web";

/**
 * Angular DI token for the universal `EntityFetcher`. Generated `<Entity>Service`
 * classes (from `@metaobjectsdev/codegen-ts-angular`) inject this token and call
 * the supplied fetcher for every HTTP request.
 *
 * Wire it via `provideEntityFetcher(fn)` in your `app.config.ts` providers.
 */
export const EntityFetcherToken = new InjectionToken<EntityFetcher>(
  "metaobjects.EntityFetcher",
);

/**
 * Convenience provider helper — supplies an `EntityFetcher` for the entire
 * application. Mirrors React's `<EntityFetcherProvider value={...} />`.
 */
export function provideEntityFetcher(fetcher: EntityFetcher): Provider {
  return { provide: EntityFetcherToken, useValue: fetcher };
}
