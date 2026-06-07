const LABELS: Record<string, string> = {
  ts: "TypeScript", java: "Java", kotlin: "Kotlin", csharp: "C#", python: "Python",
};
/** Human label for an api-surface language key. Unknown → capitalized verbatim. */
export function apiLabel(lang: string): string {
  return LABELS[lang] ?? (lang.length ? lang[0]!.toUpperCase() + lang.slice(1) : lang);
}
