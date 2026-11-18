// Typed errors for codegen-ts.

export class CodegenError extends Error {
  readonly file?: string;
  constructor(message: string, opts?: { file?: string }) {
    super(message);
    this.name = "CodegenError";
    if (opts?.file !== undefined) this.file = opts.file;
  }
}
