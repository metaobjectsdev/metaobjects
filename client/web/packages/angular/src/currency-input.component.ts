import {
  ChangeDetectionStrategy,
  Component,
  forwardRef,
  Input,
  Output,
  EventEmitter,
  signal,
  type OnChanges,
  type SimpleChanges,
} from "@angular/core";
import {
  NG_VALUE_ACCESSOR,
  type ControlValueAccessor,
} from "@angular/forms";
import {
  formatCurrency,
  minorUnitsFor,
  parseCurrency,
} from "@metaobjectsdev/runtime-web";

/**
 * Bidirectional currency input — Angular 18 standalone component mirroring
 * React's `<CurrencyInput>`.
 *
 * Inputs:
 *   - `valueCents` — integer minor units (cents for USD, yen for JPY)
 *   - `currency`   — ISO 4217 code, defaults to "USD"
 *   - `locale`     — BCP 47 locale, defaults to "en-US"
 *   - `required`
 *
 * Output:
 *   - `valueChange` — fires on blur with new minor-units value
 *
 * Implements `ControlValueAccessor` for `[(ngModel)]` and reactive forms.
 *
 * Behavior parity with the React component:
 *   - Focus strips symbol + grouping for editing
 *   - Blur re-formats + emits cents
 *   - Empty input + !required → emits 0
 *   - Empty input + required  → reverts to last valid, no emit, marks invalid
 *   - Unparseable input on blur → reverts to last valid format, no emit
 */
@Component({
  selector: "mo-currency-input",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => CurrencyInputComponent),
      multi: true,
    },
  ],
  template: `
    <input
      type="text"
      inputmode="decimal"
      [value]="displayText()"
      [class]="className"
      [placeholder]="placeholder ?? null"
      [required]="required"
      [id]="id ?? null"
      [name]="name ?? null"
      [attr.data-invalid]="isInvalid() ? 'true' : null"
      (input)="onInput($event)"
      (focus)="onFocus()"
      (blur)="onBlur()"
    />
  `,
})
export class CurrencyInputComponent implements ControlValueAccessor, OnChanges {
  @Input() valueCents = 0;
  @Input() currency = "USD";
  @Input() locale = "en-US";
  @Input() required = false;
  @Input() className = "";
  @Input() placeholder?: string;
  @Input() id?: string;
  @Input() name?: string;
  @Output() valueChange = new EventEmitter<number>();

  readonly displayText = signal("");
  readonly isInvalid = signal(false);

  private lastValidValue = 0;
  private onChangeFn: (cents: number) => void = () => {};
  private onTouchedFn: () => void = () => {};

  constructor() {
    // Initial paint — set in next microtask so OnPush won't miss it.
    queueMicrotask(() => this.resyncFromExternalValue(this.valueCents));
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["valueCents"] || changes["currency"] || changes["locale"]) {
      this.resyncFromExternalValue(this.valueCents);
    }
  }

  // ControlValueAccessor — outer form → component
  writeValue(value: unknown): void {
    const cents = typeof value === "number" && Number.isFinite(value) ? value : 0;
    this.valueCents = cents;
    this.resyncFromExternalValue(cents);
  }
  registerOnChange(fn: (cents: number) => void): void { this.onChangeFn = fn; }
  registerOnTouched(fn: () => void): void { this.onTouchedFn = fn; }
  setDisabledState?(_disabled: boolean): void {
    // The host element handles disabled via [disabled] binding if needed.
  }

  onInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.displayText.set(target.value);
  }

  onFocus(): void {
    this.isInvalid.set(false);
    const factor = Math.pow(10, minorUnitsFor(this.currency, this.locale));
    const dollars = (this.valueCents / factor).toFixed(
      minorUnitsFor(this.currency, this.locale),
    );
    this.displayText.set(dollars);
  }

  onBlur(): void {
    this.onTouchedFn();
    const trimmed = this.displayText().trim();
    if (trimmed === "") {
      if (this.required) {
        this.isInvalid.set(true);
        this.displayText.set(formatCurrency(this.valueCents, this.currency, this.locale));
        return;
      }
      this.isInvalid.set(false);
      this.emit(0);
      return;
    }
    const parsed = parseCurrency(trimmed, this.currency, this.locale);
    if (parsed === null) {
      // Unparseable — revert
      this.displayText.set(
        formatCurrency(this.lastValidValue, this.currency, this.locale),
      );
      return;
    }
    this.isInvalid.set(false);
    this.emit(parsed);
  }

  private emit(cents: number): void {
    this.valueCents = cents;
    this.lastValidValue = cents;
    this.displayText.set(formatCurrency(cents, this.currency, this.locale));
    this.valueChange.emit(cents);
    this.onChangeFn(cents);
  }

  private resyncFromExternalValue(cents: number): void {
    this.lastValidValue = cents;
    this.displayText.set(formatCurrency(cents, this.currency, this.locale));
  }
}
