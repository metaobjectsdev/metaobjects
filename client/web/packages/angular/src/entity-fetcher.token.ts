import { InjectionToken, type Provider } from "@angular/core";
import { joinBaseUrl, type EntityFetcher } from "@metaobjectsdev/runtime-web";

/**
 * Angular DI token for the universal `EntityFetcher`. Generated `<Entity>Service`
 * classes (from `@metaobjectsdev/codegen-ts-angular`) inject this token and call
 * the supplied fetcher for every HTTP request.
 *
 * The fetcher resolved from this token is already bound to `baseUrl` — generated
 * services emit entity-relative paths and never carry a prefix of their own.
 *
 * Wire it via `provideEntityFetcher({ fetcher })` in your `app.config.ts` providers.
 */
export const EntityFetcherToken = new InjectionToken<EntityFetcher>(
  "metaobjects.EntityFetcher",
);

export interface EntityFetcherOptions {
  /** Transport only. It receives an already-prefixed URL and never learns about routing. */
  fetcher: EntityFetcher;
  /**
   * Where the API lives — a path (`/api`) or a full origin
   * (`https://api.example.com/v1`).
   *
   * OPTIONAL, default `""`: same-origin at the root, which is what `meta init`
   * scaffolds (`apiPrefix: ""`). Mirrors React's `<EntityFetcherProvider baseUrl>`.
   * An absolute origin is also what makes a server-side render work, since a
   * relative URL has no origin to resolve against off the browser.
   */
  baseUrl?: string | undefined;
}

/**
 * Convenience provider helper — supplies an `EntityFetcher` for the entire
 * application, bound to `baseUrl`. Mirrors React's
 * `<EntityFetcherProvider fetcher={...} baseUrl={...} />`.
 */
export function provideEntityFetcher({ fetcher, baseUrl }: EntityFetcherOptions): Provider {
  const bound = (<T,>(path: string, init?: RequestInit) =>
    fetcher<T>(joinBaseUrl(baseUrl, path), init)) as EntityFetcher;
  return { provide: EntityFetcherToken, useValue: bound };
}
