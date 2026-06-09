export class ForgeRecordNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`Record not found: ${path}`);
    this.name = "ForgeRecordNotFoundError";
  }
}

export class ForgeAlreadyPromotedError extends Error {
  constructor(public readonly path: string) {
    super(`A canonical record already exists at: ${path}`);
    this.name = "ForgeAlreadyPromotedError";
  }
}

export class ForgeRecordParseError extends Error {
  constructor(
    public readonly path: string,
    public override readonly cause: unknown,
  ) {
    super(`Failed to parse record at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ForgeRecordParseError";
  }
}
