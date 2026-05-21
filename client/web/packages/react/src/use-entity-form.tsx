// React form helper — useEntityForm.
//
// Single export that returns React Hook Form's `useForm` surface PLUS a
// pre-bound `.input` accessor: one entry per field on the entity, ready to
// spread onto an <input> element. Every metadata-derived attribute
// (placeholder, type, aria-label, RHF rules) rides along automatically.
//
// Usage:
//
//   import { useEntityForm } from '@metaobjects/react';
//   import { Subscriber, SubscriberInsertSchema } from './generated/Subscriber';
//
//   const form = useEntityForm(Subscriber, SubscriberInsertSchema);
//
//   <input {...form.input.email} />
//   <input {...form.input.firstName} />
//
// React, react-hook-form, @hookform/resolvers, and zod are OPTIONAL peer
// dependencies. The subpath is only loaded when imported.

import { useMemo } from "react";
import {
  useForm,
  type FieldValues,
  type DefaultValues,
  type Path,
  type RegisterOptions,
  type UseFormReturn,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { ZodTypeAny } from "zod";

// ---------------------------------------------------------------------------
// Field shape — what each non-`$`-prefixed key on an Entity constants object
// looks like. The codegen emits this; consumers don't construct it by hand.
// ---------------------------------------------------------------------------

export interface EntityFieldMeta {
  readonly name: string;
  readonly label: string;
  readonly view: string;
  readonly htmlType?: string;
  readonly placeholder?: string;
  readonly helpText?: string;
  readonly rules?: RegisterOptions;
}

/**
 * Minimal shape of an entity constants object. The `$`-prefixed keys are
 * entity-level meta (entity name, table, route path). Every other key is a
 * field-level meta object.
 */
export interface EntityMeta {
  readonly $entity: string;
  readonly $table: string;
  readonly $path: string;
  readonly [field: string]: string | EntityFieldMeta;
}

// ---------------------------------------------------------------------------
// Pre-bound input props per field. Spread onto a native <input>.
// ---------------------------------------------------------------------------

/** Props returned by `form.input.<fieldName>` — spreadable onto <input>. */
// biome-ignore lint/suspicious/noExplicitAny: RHF's register() returns a heavily
// generic type; we spread the result and add metadata-derived attrs alongside.
export type BoundInputProps = Record<string, any>;

/**
 * Mapped type: for each non-`$`-prefixed key in TEntity, expose its
 * pre-bound input props. Keys whose value isn't a field meta object are
 * stripped out at the type level so consumers only see real fields.
 */
export type InputAccessor<TEntity> = {
  readonly [K in keyof TEntity as TEntity[K] extends EntityFieldMeta ? K : never]: BoundInputProps;
};

// ---------------------------------------------------------------------------
// useEntityForm
// ---------------------------------------------------------------------------

export interface UseEntityFormOptions<T extends FieldValues> {
  defaultValues?: DefaultValues<T>;
}

export type UseEntityFormReturn<T extends FieldValues, TEntity> = UseFormReturn<T> & {
  input: InputAccessor<TEntity>;
};

/**
 * React Hook Form set up with the generated Zod resolver, plus an `.input`
 * accessor that binds register() output to each field's metadata-derived
 * attrs (placeholder, type, aria-label, rules). Consumers spread these
 * props onto <input> elements and never hand-pass anything else.
 *
 * For non-`<input>` controls (textarea, select), `type` will be omitted from
 * the props and consumers render the right element themselves.
 */
export function useEntityForm<TEntity extends EntityMeta, T extends FieldValues = FieldValues>(
  entity: TEntity,
  schema: ZodTypeAny,
  opts: UseEntityFormOptions<T> = {},
): UseEntityFormReturn<T, TEntity> {
  // Cast the resolver: @hookform/resolvers' Zod adapter is typed for Zod 3;
  // schemas authored by codegen-ts may be Zod 4. The runtime shape (safeParse)
  // is compatible, so cast at the boundary.
  // biome-ignore lint/suspicious/noExplicitAny: zod 3/4 type-shape gap
  const resolver = zodResolver(schema as any);
  const form = useForm<T>({
    resolver,
    ...(opts.defaultValues !== undefined ? { defaultValues: opts.defaultValues } : {}),
  });

  // Build `.input` once per render. RHF's register() is stable across renders
  // (its identity doesn't change unless the form instance does), so this is
  // safe to memo on the form object.
  const input = useMemo(() => {
    const acc: Record<string, BoundInputProps> = {};
    for (const [key, value] of Object.entries(entity)) {
      if (key.startsWith("$")) continue;
      if (!value || typeof value !== "object" || !("name" in value)) continue;
      const field = value as EntityFieldMeta;
      // Cast rules: RegisterOptions is parameterized by the form's FieldValues
      // and Path; constants emit a structurally-compatible plain RegisterOptions.
      // biome-ignore lint/suspicious/noExplicitAny: structural rules pass through to RHF
      const registered = form.register(field.name as Path<T>, (field.rules ?? {}) as any);
      const props: BoundInputProps = { ...registered, "aria-label": field.label };
      if (field.htmlType !== undefined) props.type = field.htmlType;
      if (field.placeholder !== undefined) props.placeholder = field.placeholder;
      acc[key] = props;
    }
    return acc as InputAccessor<TEntity>;
    // form is the only relevant dep; entity is a stable codegen-emitted constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, entity]);

  return Object.assign(form, { input });
}
