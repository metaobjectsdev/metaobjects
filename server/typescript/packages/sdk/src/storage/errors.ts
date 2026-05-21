export class MetaForgeRecordNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`Record not found: ${path}`);
    this.name = "MetaForgeRecordNotFoundError";
  }
}

export class MetaForgeAlreadyPromotedError extends Error {
  constructor(public readonly path: string) {
    super(`A canonical record already exists at: ${path}`);
    this.name = "MetaForgeAlreadyPromotedError";
  }
}

export class MetaForgeRecordParseError extends Error {
  constructor(
    public readonly path: string,
    public override readonly cause: unknown,
  ) {
    super(`Failed to parse record at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MetaForgeRecordParseError";
  }
}
