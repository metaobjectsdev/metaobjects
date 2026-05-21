import { useState, useEffect, useRef } from "react";
import type { ReactElement, FocusEvent, ChangeEvent } from "react";
import { formatCurrency, parseCurrency, minorUnitsFor } from "@metaobjects/runtime-web";

export interface CurrencyInputProps {
  /** Value in integer minor units (cents for USD). */
  value: number;
  /** Called with new value in integer minor units after blur. */
  onChange: (cents: number) => void;
  /** ISO 4217 currency code. Defaults to "USD". */
  currency?: string;
  /** BCP 47 locale code. Defaults to "en-US". */
  locale?: string;
  className?: string;
  placeholder?: string;
  required?: boolean;
  id?: string;
  name?: string;
}

/**
 * Bidirectional currency input. Displays formatted dollars; captures
 * dollars from the user; emits cents to onChange on blur.
 *
 * - Focus strips symbol + grouping for easier editing
 * - Blur re-formats + emits cents
 * - Empty input + !required → emits 0
 * - Empty input + required → reverts to last valid; no onChange
 * - Unparseable input on blur → reverts to last valid format; no onChange
 * - Float drift avoided via Math.round in parseCurrency
 */
export function CurrencyInput(props: CurrencyInputProps): ReactElement {
  const currency = props.currency ?? "USD";
  const locale = props.locale ?? "en-US";

  const [text, setText] = useState(() => formatCurrency(props.value, currency, locale));
  const [isInvalid, setIsInvalid] = useState(false);
  const lastValidValue = useRef(props.value);

  // Re-format when external value changes (controlled component sync)
  useEffect(() => {
    if (props.value !== lastValidValue.current) {
      setText(formatCurrency(props.value, currency, locale));
      lastValidValue.current = props.value;
    }
  }, [props.value, currency, locale]);

  function handleFocus(_e: FocusEvent<HTMLInputElement>) {
    setIsInvalid(false);
    // Strip symbol + grouping so user can edit the raw number
    const minorUnits = minorUnitsFor(currency, locale);
    const factor = Math.pow(10, minorUnits);
    const dollars = (props.value / factor).toFixed(minorUnits);
    setText(dollars);
  }

  function handleBlur(_e: FocusEvent<HTMLInputElement>) {
    const trimmed = text.trim();
    if (trimmed === "") {
      if (props.required) {
        setIsInvalid(true);
        setText(formatCurrency(props.value, currency, locale));
        return;
      }
      setIsInvalid(false);
      props.onChange(0);
      lastValidValue.current = 0;
      setText(formatCurrency(0, currency, locale));
      return;
    }
    const parsed = parseCurrency(trimmed, currency, locale);
    if (parsed === null) {
      // Unparseable — revert to last valid
      setText(formatCurrency(lastValidValue.current, currency, locale));
      return;
    }
    setIsInvalid(false);
    props.onChange(parsed);
    lastValidValue.current = parsed;
    setText(formatCurrency(parsed, currency, locale));
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    setText(e.target.value);
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={props.className}
      placeholder={props.placeholder}
      required={props.required}
      id={props.id}
      name={props.name}
      data-invalid={isInvalid ? "true" : undefined}
    />
  );
}
