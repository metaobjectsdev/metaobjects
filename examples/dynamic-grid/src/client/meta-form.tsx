/**
 * `<MetaForm entity="WorkOrder" />`: create a row of any entity, or with `id` edit one.
 *
 * Every control is chosen from the field's metadata: an enum is a select of its members, a
 * foreign key a select of the rows it may point at, a value object a group of its own
 * members, a decimal a text box that keeps the digits typed, money a currency box. Required
 * marks, length limits and numeric bounds come from the same place.
 *
 * The server is the validator. It runs the model's validators and the hand-written business
 * rules, and this form puts each issue it answers beside the field it names.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useEntityPathFetcher } from "@metaobjectsdev/tanstack";
import { describeError, validationIssues, type Row } from "./api";
import { useEntity, useModel } from "./context";
import { FieldInput } from "./controls";
import { controlFor, editableFields, newFormValues, toBody, toFormValues, type FormValue, type FormValues } from "./form-values";
import type { EntityModel, FieldModel, ObjectModel } from "./model";

export interface MetaFormProps {
  /** The entity to edit, by the name the metadata gives it. Nothing else is required. */
  readonly entity: string;
  /** The key of the row to edit. Without it the form creates a row. */
  readonly id?: string | number;
  /** Values a new row starts with, over the model's defaults (the work order a new line belongs to). */
  readonly initial?: Row;
  readonly onSaved?: (row: Row) => void;
  readonly onDeleted?: () => void;
  readonly onCancel?: () => void;
}

function isValues(value: FormValue | undefined): value is FormValues {
  return typeof value === "object" && value !== null;
}

/** The controls for the fields of one object: an entity, or a value object inside one. */
function Fields(props: {
  readonly object: ObjectModel;
  readonly values: FormValues;
  readonly onChange: (values: FormValues) => void;
  readonly issues: ReadonlyMap<string, string>;
  /** `billingAddress.` inside a value object: the prefix of an issue path and of an input id. */
  readonly under: string;
  readonly idPrefix: string;
}): ReactNode {
  const { object, values, issues, under } = props;
  const set = (field: FieldModel, value: FormValue): void => props.onChange({ ...values, [field.name]: value });

  return editableFields(object).map((field) => {
    const kind = controlFor(field);
    const path = `${under}${field.name}`;
    const id = `${props.idPrefix}-${path}`;
    const issue = issues.get(path);
    const label = `${field.label}${field.required ? " *" : ""}`;

    if (kind === "group" && field.valueObject !== undefined) {
      const held = values[field.name];
      return (
        <fieldset key={field.name} className="mo-group">
          <legend>{label}</legend>
          {issue !== undefined && <p role="alert">{issue}</p>}
          <Fields
            object={field.valueObject}
            values={isValues(held) ? held : {}}
            onChange={(inner) => set(field, inner)}
            issues={issues}
            under={`${path}.`}
            idPrefix={props.idPrefix}
          />
        </fieldset>
      );
    }
    return (
      <div key={field.name} className="mo-field">
        <label htmlFor={id}>{label}</label>
        {kind === undefined || kind === "group" ? (
          // Said, not hidden: a field this form cannot edit is left out of what it sends.
          <p id={id}>This form has no control for field.{field.subType}.</p>
        ) : (
          <FieldInput field={field} kind={kind} id={id} value={values[field.name] ?? ""} invalid={issue !== undefined} onChange={(v) => set(field, v)} />
        )}
        {issue !== undefined && <p role="alert">{issue}</p>}
      </div>
    );
  });
}

function Form(props: MetaFormProps & { readonly model: EntityModel }): ReactNode {
  const entity = props.model;
  const fetcher = useEntityPathFetcher();
  const editing = props.id !== undefined;
  const rowPath = `${entity.path}/${encodeURIComponent(String(props.id))}`;

  // The row as the server last returned it: what an edit is compared against.
  const [stored, setStored] = useState<Row | undefined>(undefined);
  const [values, setValues] = useState<FormValues | undefined>(() =>
    editing ? undefined : { ...newFormValues(entity), ...withoutUnset(entity, props.initial) },
  );
  const [issues, setIssues] = useState<ReadonlyMap<string, string>>(new Map());
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) return;
    let live = true;
    fetcher<Row>(rowPath).then(
      (row) => {
        if (!live) return;
        setStored(row);
        setValues(toFormValues(entity, row));
      },
      (err: unknown) => {
        if (live) setFailure(describeError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [editing, entity, fetcher, rowPath]);

  /** Put a refusal where it belongs: beside its fields when the server named them, else above the form. */
  const refused = (err: unknown): void => {
    const byField = validationIssues(err);
    if (byField === undefined) setFailure(describeError(err));
    else setIssues(byField);
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (values === undefined) return;
    setFailure(undefined);
    const { body, issues: found } = toBody(entity, values, editing ? stored : undefined);
    setIssues(new Map(found.map((issue) => [issue.path, issue.message])));
    if (found.length > 0) return;
    setBusy(true);
    try {
      const saved = await fetcher<Row>(editing ? rowPath : entity.path, { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) });
      if (editing) {
        setStored(saved);
        setValues(toFormValues(entity, saved));
      } else {
        // Ready for the next one, with the same starting values.
        setValues({ ...newFormValues(entity), ...withoutUnset(entity, props.initial) });
      }
      props.onSaved?.(saved);
    } catch (err) {
      refused(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    try {
      await fetcher<undefined>(rowPath, { method: "DELETE" });
      props.onDeleted?.();
    } catch (err) {
      refused(err);
    } finally {
      setBusy(false);
    }
  };

  const title = editing ? `Edit ${entity.label}` : `New ${entity.label}`;
  return (
    <form className="mo-form" aria-label={title} noValidate onSubmit={(event) => void submit(event)}>
      <h2>{title}</h2>
      {failure !== undefined && <p role="alert">{failure}</p>}
      {values === undefined ? (
        failure === undefined && <p>Loading…</p>
      ) : (
        <>
          <Fields object={entity} values={values} onChange={setValues} issues={issues} under="" idPrefix={`${entity.name}-form`} />
          <div className="mo-actions">
            <button type="submit" disabled={busy}>
              {editing ? "Save" : "Create"}
            </button>
            {editing && (
              <button type="button" disabled={busy} onClick={() => void remove()}>
                Delete
              </button>
            )}
            {props.onCancel !== undefined && (
              <button type="button" onClick={props.onCancel}>
                Close
              </button>
            )}
          </div>
        </>
      )}
    </form>
  );
}

/** The form values of the fields `initial` actually sets, so they win over the model's defaults. */
function withoutUnset(entity: EntityModel, initial: Row | undefined): FormValues {
  if (initial === undefined) return {};
  const all = toFormValues(entity, initial);
  return Object.fromEntries(Object.entries(all).filter(([name]) => initial[name] !== undefined));
}

export function MetaForm(props: MetaFormProps): ReactNode {
  const model = useModel();
  const entity = useEntity(props.entity);
  // Keyed like the grid: another entity, another row or a reloaded model is a fresh form.
  return <Form key={`${entity.name}/${String(props.id ?? "new")}@${model.revision}`} {...props} model={entity} />;
}
