# @metaobjectsdev/codegen-ts-angular

Angular 18 codegen for MetaObjects. Emits standalone-component / signal-based output that pairs with `@metaobjectsdev/angular` (runtime).

Generators:

- `angularServiceFile()` — `<Entity>.service.ts`: `@Injectable({ providedIn: 'root' })` class wrapping `EntityFetcherToken` with `list / get / create / update / delete` methods matching the cross-port REST URL grammar.
- `angularFormFile()` — `<Entity>.form.component.ts`: standalone component with Angular reactive forms + signal inputs, mirroring React's `useEntityForm`.
- `angularGridFile()` — `<Entity>.grid.component.ts`: standalone component over `<mo-entity-grid>` with column defs derived from `layout.dataGrid` metadata.
- `barrel()` — `index.ts` re-exporting all per-entity Angular outputs.

Per-entity opt-out: `@emitAngular: false` on an entity skips all three Angular outputs.

## Install

```bash
pnpm add -D @metaobjectsdev/codegen-ts-angular
```

## License

Apache-2.0.
