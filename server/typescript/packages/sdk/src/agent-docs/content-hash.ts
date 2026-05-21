import { createHash } from "node:crypto";

export function computeContentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** Returns the body with a content-hash HTML comment prepended. */
export function withContentHash(body: string): string {
  const hash = computeContentHash(body);
  return `<!-- metaobjects-content-hash: ${hash} -->\n${body}`;
}

/** Extract the embedded hash, or undefined if not present. */
export function extractContentHash(fileBody: string): string | undefined {
  const match = /<!-- metaobjects-content-hash: ([a-f0-9]{64}) -->/.exec(fileBody);
  return match?.[1];
}

/** True iff the file body's hash matches its own content (i.e. unmodified). */
export function isUnmodified(fileBody: string): boolean {
  const embedded = extractContentHash(fileBody);
  if (embedded === undefined) return false;
  const withoutHash = fileBody.replace(/^<!-- metaobjects-content-hash: [a-f0-9]{64} -->\n/, "");
  return computeContentHash(withoutHash) === embedded;
}
