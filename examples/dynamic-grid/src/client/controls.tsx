/**
 * One input for one field, chosen and configured from the field's metadata. Shared by the
 * form (editing a value) and the grid's filter bar (typing a value to filter by).
 */
import type { ReactNode } from "react";
import {
  FIELD_ATTR_MAX_LENGTH,
  VALIDATOR_ATTR_MAX,
  VALIDATOR_ATTR_MIN,
  VALIDATOR_SUBTYPE_NUMERIC,
  VIEW_TEXTAREA_ATTR_ROWS,
} from "@metaobjectsdev/metadata/constants";
import { CurrencyInput } from "@metaobjectsdev/react";
import { useModel } from "./context";
import { currencyCode, currencyLocale, enumLabel } from "./format";
import type { ControlKind, FormValue } from "./form-values";
import type { FieldModel } from "./model";
import { useReferenceOptions } from "./references";

export interface FieldInputProps {
  readonly field: FieldModel;
  readonly kind: Exclude<ControlKind, "group">;
  readonly value: FormValue;
  readonly onChange: (value: FormValue) => void;
  readonly id: string;
  /** Names the control for assistive technology when no `<label>` points at it. */
  readonly label?: string;
  readonly invalid?: boolean;
  /** Whether an empty choice is offered by a select. A filter always wants one chosen. */
  readonly allowEmpty?: boolean;
}

/** `@min` / `@max` of the field's `validator.numeric`, as input attributes. */
function numericBounds(field: FieldModel): { min?: number; max?: number } {
  const validator = field.validators.find((v) => v.subType === VALIDATOR_SUBTYPE_NUMERIC);
  const min = validator?.attr(VALIDATOR_ATTR_MIN);
  const max = validator?.attr(VALIDATOR_ATTR_MAX);
  return { ...(typeof min === "number" ? { min } : {}), ...(typeof max === "number" ? { max } : {}) };
}

function ReferenceSelect(props: FieldInputProps & { common: Record<string, unknown> }): ReactNode {
  const model = useModel();
  const target = props.field.references === undefined ? undefined : model.entity(props.field.references);
  const options = useReferenceOptions(target);
  const held = typeof props.value === "string" ? props.value : "";
  return (
    <select {...props.common} value={held} onChange={(e) => props.onChange(e.target.value)}>
      {(props.allowEmpty ?? true) && <option value="">{options === undefined ? "Loading…" : "—"}</option>}
      {/* The row an edit already points at stays selectable while the list loads. */}
      {held !== "" && options?.some((o) => o.value === held) !== true && <option value={held}>#{held}</option>}
      {options?.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function FieldInput(props: FieldInputProps): ReactNode {
  const { field, kind, value, onChange, id } = props;
  const common = {
    id,
    name: field.name,
    ...(props.label !== undefined ? { "aria-label": props.label } : {}),
    ...(props.invalid === true ? { "aria-invalid": true } : {}),
  };
  const text = typeof value === "string" ? value : "";
  const allowEmpty = props.allowEmpty ?? true;

  switch (kind) {
    case "checkbox":
      return <input {...common} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case "select":
      return (
        <select {...common} value={text} onChange={(e) => onChange(e.target.value)}>
          {allowEmpty && <option value="">—</option>}
          {field.enumValues.map((member) => (
            <option key={member} value={member}>
              {enumLabel(member)}
            </option>
          ))}
        </select>
      );
    case "reference":
      return <ReferenceSelect {...props} common={common} />;
    case "currency": {
      const code = currencyCode(field);
      const locale = currencyLocale(field);
      return (
        <CurrencyInput
          id={id}
          name={field.name}
          value={typeof value === "number" ? value : 0}
          onChange={onChange}
          required={field.required}
          {...(code !== undefined ? { currency: code } : {})}
          {...(locale !== undefined ? { locale } : {})}
        />
      );
    }
    case "textarea": {
      const rows = field.view?.attr(VIEW_TEXTAREA_ATTR_ROWS);
      const maxLength = field.attr(FIELD_ATTR_MAX_LENGTH);
      return (
        <textarea
          {...common}
          value={text}
          rows={typeof rows === "number" ? rows : 3}
          {...(typeof maxLength === "number" ? { maxLength } : {})}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    case "date":
      return <input {...common} type="date" value={text} onChange={(e) => onChange(e.target.value)} />;
    case "integer":
      return <input {...common} type="number" step={1} {...numericBounds(field)} value={text} onChange={(e) => onChange(e.target.value)} />;
    case "number":
      return <input {...common} type="number" step="any" {...numericBounds(field)} value={text} onChange={(e) => onChange(e.target.value)} />;
    case "decimal":
      // Text, not type=number: a number input hands back a double, and a decimal must not pass through one.
      return <input {...common} type="text" inputMode="decimal" value={text} onChange={(e) => onChange(e.target.value)} />;
    case "text": {
      const maxLength = field.attr(FIELD_ATTR_MAX_LENGTH);
      return (
        <input
          {...common}
          type="text"
          value={text}
          {...(typeof maxLength === "number" ? { maxLength } : {})}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
  }
}
