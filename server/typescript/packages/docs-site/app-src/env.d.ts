// The explorer's templates by basename, which scripts/build-app.ts supplies to the bundle.
declare module "explorer-templates" {
  const templates: Readonly<Record<string, string>>;
  export default templates;
}
