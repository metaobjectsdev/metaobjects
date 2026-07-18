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

// fixtures/api-contract-conformance/m2m/ — FR-018 many-to-many traversal corpus
// (hetero / directed-self-join / symmetric over HTTP, both lanes).
export const API_CONTRACT_M2M_DIR = resolve(API_CONTRACT_DIR, "m2m");
export const API_CONTRACT_M2M_SCENARIOS_DIR = resolve(API_CONTRACT_M2M_DIR, "scenarios");

// fixtures/api-contract-conformance/tph/ — FR-017 table-per-hierarchy
// polymorphic CRUD corpus (polymorphic list/get + per-subtype CRUD over HTTP,
// both lanes).
export const API_CONTRACT_TPH_DIR = resolve(API_CONTRACT_DIR, "tph");
export const API_CONTRACT_TPH_SCENARIOS_DIR = resolve(API_CONTRACT_TPH_DIR, "scenarios");

// fixtures/api-contract-conformance/jsonb/ — `field.string @dbColumnType:jsonb`
// open-bag parsed-value corpus (POST a JSON object, read it back as an object —
// never a JSON-encoded string), both lanes.
export const API_CONTRACT_JSONB_DIR = resolve(API_CONTRACT_DIR, "jsonb");
export const API_CONTRACT_JSONB_SCENARIOS_DIR = resolve(API_CONTRACT_JSONB_DIR, "scenarios");

// #214 write-through read-your-writes subcorpus.
export const API_CONTRACT_WRITE_THROUGH_DIR = resolve(API_CONTRACT_DIR, "write-through");
export const API_CONTRACT_WRITE_THROUGH_SCENARIOS_DIR = resolve(API_CONTRACT_WRITE_THROUGH_DIR, "scenarios");

// fixtures/validation-conformance/ — cross-port generated input-validation corpus.
export const VALIDATION_DIR = resolve(repoRoot, "fixtures", "validation-conformance");
