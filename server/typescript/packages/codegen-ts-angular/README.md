# @metaobjectsdev/codegen-ts-angular

Angular 18 codegen for MetaObjects. Emits standalone-component / signal-based output that pairs with `@metaobjectsdev/angular` (runtime).

Generators:

- `angularServiceFile()` — `<Entity>.service.ts`: `@Injectable({ providedIn: 'root' })` class wrapping `EntityFetcherToken` with `list / get / create / update / delete` methods matching the cross-port REST URL grammar.
- `angularFormFile()` — `<Entity>.form.component.ts`: standalone component with Angular reactive forms + signal inputs, mirroring React's `useEntityForm`.
- `angularGridFile()` — `<Entity>.grid.component.ts`: standalone component over `<mo-entity-grid>` with column defs derived from `layout.dataGrid` metadata.
- `barrel()` — `index.ts` re-exporting all per-entity Angular outputs.

Per-entity opt-out: `@emitAngular: false` on an entity skips all three Angular outputs.

## Install

> **NOT published to npm — source-only by decision**
> ([ADR-0048](../../../../spec/decisions/ADR-0048-angular-tier-source-only.md)).
> This package builds in-repo on its own `0.6.x` line, but has never been released —
> `npm i @metaobjectsdev/codegen-ts-angular` returns a 404, and that is deliberate:
> the tier is not yet at the published tier's bar (the promotion checklist lives in
> the ADR — notably view-kind form dispatch, TPH handling, and generated services
> importing the DB-free `<Entity>.meta` descriptor). Consume it from source
> (a workspace/file dependency, or `npm pack` + install the tarball) by building
> from this directory; it is a dev-time codegen tool, so a `-D`/dev dependency.
> The published browser-client tier is React + TanStack; see
> [`docs/ports/typescript-client.md`](../../../../docs/ports/typescript-client.md).

## License

Apache-2.0.
