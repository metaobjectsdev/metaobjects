// All errors extend RuntimeError and JSON-serialize via toJSON() — admin UIs and MCP tools
// surface them as structured JSON, not Error.message strings.

export interface ValidationFailure {
  field: string;
  rule: string;
  message: string;
  expected?: unknown;
  received?: unknown;
}

interface BaseOpts {
  code?: string;
  entity?: string;
  cause?: unknown;
}

export class RuntimeError extends Error {
  readonly code: string;
  readonly entity?: string;
  override readonly cause?: unknown;

  constructor(message: string, opts: BaseOpts & { code: string }) {
    super(message);
    this.name = "RuntimeError";
    this.code = opts.code;
    if (opts.entity !== undefined) this.entity = opts.entity;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { name: this.name, code: this.code, message: this.message };
    if (this.entity !== undefined) out.entity = this.entity;
    return out;
  }
}

export class ValidationError extends RuntimeError {
  readonly errors: ValidationFailure[];

  constructor(message: string, opts: { entity?: string; errors: ValidationFailure[]; cause?: unknown }) {
    super(message, { code: "validation_failed", ...(opts.entity !== undefined ? { entity: opts.entity } : {}), ...(opts.cause !== undefined ? { cause: opts.cause } : {}) });
    this.name = "ValidationError";
    this.errors = opts.errors;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), errors: this.errors };
  }
}

export class NotFoundError extends RuntimeError {
  readonly id: unknown;

  constructor(message: string, opts: { entity: string; id: unknown; cause?: unknown }) {
    super(message, { code: "not_found", entity: opts.entity, ...(opts.cause !== undefined ? { cause: opts.cause } : {}) });
    this.name = "NotFoundError";
    this.id = opts.id;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), id: this.id };
  }
}

export class ConstraintViolationError extends RuntimeError {
  readonly kind: "unique" | "foreign_key" | "not_null" | "check";
  readonly table: string;
  readonly field?: string;
  readonly detail?: string;

  constructor(message: string, opts: {
    kind: "unique" | "foreign_key" | "not_null" | "check";
    table: string;
    field?: string;
    detail?: string;
    cause?: unknown;
  }) {
    super(message, { code: "constraint_violation", ...(opts.cause !== undefined ? { cause: opts.cause } : {}) });
    this.name = "ConstraintViolationError";
    this.kind = opts.kind;
    this.table = opts.table;
    if (opts.field !== undefined) this.field = opts.field;
    if (opts.detail !== undefined) this.detail = opts.detail;
  }

  override toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { ...super.toJSON(), kind: this.kind, table: this.table };
    if (this.field !== undefined) out.field = this.field;
    if (this.detail !== undefined) out.detail = this.detail;
    return out;
  }
}

export class MetadataError extends RuntimeError {
  constructor(message: string, opts: { entity?: string; cause?: unknown } = {}) {
    super(message, { code: "metadata_error", ...(opts.entity !== undefined ? { entity: opts.entity } : {}), ...(opts.cause !== undefined ? { cause: opts.cause } : {}) });
    this.name = "MetadataError";
  }
}

export class UnsafeNameError extends RuntimeError {
  readonly value: string;

  constructor(message: string, opts: { value: string }) {
    super(message, { code: "unsafe_name" });
    this.name = "UnsafeNameError";
    this.value = opts.value;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), value: this.value };
  }
}
