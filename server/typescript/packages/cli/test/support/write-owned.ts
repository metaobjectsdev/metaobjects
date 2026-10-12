// Write one generator the way `meta eject` does — the generator, and the template modules it
// calls beside it — for a test that builds a project by hand and needs to change something
// about the copy first. Synchronous, because the fixtures that need it are.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { closureOf } from "../../src/lib/template-eject.js";

export function writeOwned(dir: string, name: string, transform: (generatorSource: string) => string = (s) => s): void {
  const closure = closureOf(name);
  for (const file of [closure.generator, ...closure.templates]) {
    const path = join(dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file === closure.generator ? transform(file.content) : file.content);
  }
}
