// Resolve the persistence-conformance corpus location relative to this package.
// Layout: <repo>/server/typescript/packages/integration-tests → <repo>/fixtures/persistence-conformance.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// src → integration-tests → packages → typescript → server → repo-root
const repoRoot = resolve(here, "..", "..", "..", "..", "..");

export const CORPUS_DIR = resolve(repoRoot, "fixtures", "persistence-conformance");
export const CANONICAL_DIR = resolve(CORPUS_DIR, "canonical");
export const MIGRATIONS_DIR = resolve(CORPUS_DIR, "migrations");
export const QUERIES_DIR = resolve(CORPUS_DIR, "queries");

// fixtures/api-contract-conformance/ — cross-port REST API contract corpus.
export const API_CONTRACT_DIR = resolve(repoRoot, "fixtures", "api-contract-conformance");
export const API_CONTRACT_SCENARIOS_DIR = resolve(API_CONTRACT_DIR, "scenarios");
