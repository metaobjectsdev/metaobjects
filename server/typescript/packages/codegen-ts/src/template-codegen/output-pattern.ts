// Expands the tiny, fixed output-pattern grammar shared cross-port (SP-1 §3.3).
// Placeholders: {name}, {Name} (PascalCase of name), {package} (:: → /), and {path}: the
// page a docs-view node or requirement lives at (`docs/features/docs-view.md`, "Pages and
// anchors"), which only the perNode and perRequirement scopes have.
// An empty {package} collapses its trailing slash so `{package}/{name}` with no
// package yields just `{name}`. Unknown placeholders are a hard error.

const KNOWN = new Set(["name", "Name", "package", "path"]);

function pascalCase(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

export function expandOutputPattern(
  pattern: string,
  vars: { name?: string; package?: string; path?: string },
): string {
  let pkgWasEmpty = false;
  const out = pattern.replace(/\{(\w+)\}/g, (_m, token: string) => {
    if (!KNOWN.has(token)) {
      throw new Error(`unknown placeholder {${token}} in output pattern '${pattern}'`);
    }
    if (token === "package") {
      const p = (vars.package ?? "").replaceAll("::", "/");
      if (p === "") pkgWasEmpty = true;
      return p;
    }
    if (token === "path") {
      if (vars.path === undefined) {
        throw new Error(`output pattern '${pattern}' uses {path} but no page path is in scope (the perNode and perRequirement scopes give one)`);
      }
      return vars.path;
    }
    if (vars.name === undefined) {
      throw new Error(`output pattern '${pattern}' uses {${token}} but no entity name is in scope`);
    }
    return token === "Name" ? pascalCase(vars.name) : vars.name;
  });
  return pkgWasEmpty ? out.replace(/^\/+/, "").replace(/\/{2,}/g, "/") : out;
}
