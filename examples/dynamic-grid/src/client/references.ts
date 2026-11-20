/**
 * Showing a foreign key as the row it points at. Which entity that is comes from the
 * field's `identity.reference` in the metadata; nothing here names one.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { buildFilterQs } from "@metaobjectsdev/runtime-web";
import { useEntityPathFetcher } from "@metaobjectsdev/tanstack";
import type { Row } from "./api";
import { useModel } from "./context";
import { displayValue } from "./format";
import type { EntityModel, FieldModel, ObjectModel } from "./model";

/** What a person calls a row: its title field, shown the way that field is shown. */
export function rowTitle(entity: EntityModel, row: Row): string {
  const title = entity.field(entity.titleField);
  return title === undefined ? String(row[entity.keyField]) : displayValue(title, row[entity.titleField]);
}

const cacheKey = (entity: string, id: unknown): string => `${entity}/${String(id)}`;

/**
 * The titles of the rows that `rows` refer to, for every foreign-key field of `object`.
 * Returns a lookup that answers undefined until the referenced row has been fetched.
 */
export function useReferenceTitles(object: ObjectModel, rows: readonly Row[]): (field: FieldModel, value: unknown) => string | undefined {
  const model = useModel();
  const fetcher = useEntityPathFetcher();
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  // What has been asked for, so a re-render does not ask again. It lasts as long as the
  // component: a grid is mounted afresh for a reloaded model, which may title rows differently.
  const asked = useRef(new Set<string>());

  useEffect(() => {
    for (const field of object.fields) {
      const target = field.references === undefined ? undefined : model.entity(field.references);
      if (target === undefined) continue;
      for (const row of rows) {
        const id = row[field.name];
        const key = cacheKey(target.name, id);
        if (id === null || id === undefined || asked.current.has(key)) continue;
        asked.current.add(key);
        fetcher<Row>(`${target.path}/${encodeURIComponent(String(id))}`).then(
          // Kept whichever page is showing by now: a title is asked for once, so an answer
          // dropped because the rows changed meanwhile would never be asked for again.
          (referenced) => setTitles((known) => new Map(known).set(key, rowTitle(target, referenced))),
          // A row that is gone, or a list the caller may not read: the cell keeps the key.
          () => undefined,
        );
      }
    }
  }, [fetcher, model, object, rows]);

  return useMemo(
    () => (field, value) => (field.references === undefined ? undefined : titles.get(cacheKey(field.references, value))),
    [titles],
  );
}

export interface ReferenceOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The rows a foreign key may point at, for a `<select>`: the first page of the referenced
 * entity, at the largest page the server allows. An entity with more rows than that needs
 * a search box, which this example does not have.
 */
export function useReferenceOptions(target: EntityModel | undefined): readonly ReferenceOption[] | undefined {
  const model = useModel();
  const fetcher = useEntityPathFetcher();
  const [options, setOptions] = useState<readonly ReferenceOption[] | undefined>(undefined);

  useEffect(() => {
    if (target === undefined) return;
    let live = true;
    const sortable = target.field(target.titleField)?.sortable === true;
    const query = buildFilterQs({
      ...(model.maxLimit !== undefined ? { limit: model.maxLimit } : {}),
      ...(sortable ? { sort: `${target.titleField}:asc` } : {}),
    });
    fetcher<Row[]>(`${target.path}${query === "" ? "" : `?${query}`}`).then(
      (rows) => {
        if (live) setOptions(rows.map((row) => ({ value: String(row[target.keyField]), label: rowTitle(target, row) })));
      },
      () => {
        if (live) setOptions([]);
      },
    );
    return () => {
      live = false;
    };
  }, [fetcher, model.maxLimit, target]);

  return options;
}
