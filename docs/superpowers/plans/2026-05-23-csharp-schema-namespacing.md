# C# `@schema` First-Class Support Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Prerequisite:** Plan A (`2026-05-23-csharp-constants-colocation.md`) must land first — this plan adds files under `Persistence/Source/` which Plan A creates.

**Goal:** Carry the TS schema-namespacing feature (Plan 1, shipped 2026-05-20) over to the C# port. The `@schema` attribute on `source[dbTable]` / `source[dbView]` is currently opaque-passthrough on C# — fixtures pass round-trip but the C# loader doesn't declare the attr or enforce its enum values. This plan adds the `SOURCE_ATTR_SCHEMA` constant, the schema entry in `Persistence/Source/SourceSchema.cs`, and the `DEFAULT_DB_SCHEMA_POSTGRES` constant — bringing C# to parity with TS for this attr.

**Architecture:** Pure addition to the per-concern `Persistence/Source/` files that Plan A creates. No new validation passes needed (the schema-namespacing feature doesn't require cross-attribute rules). Conformance fixtures already exist at `fixtures/conformance/source-db-table-with-schema/` etc. — they pass via opaque-attr passthrough today; after this plan they pass via first-class attr validation.

**Tech Stack:** C# 12 / .NET 8, xUnit-style tests via `dotnet test`.

---

## File Structure

**Modify (created by Plan A):**
- `server/csharp/MetaObjects/Persistence/Source/SourceConstants.cs` — add `ATTR_SCHEMA` + `DEFAULT_DB_SCHEMA_POSTGRES`
- `server/csharp/MetaObjects/Persistence/Source/SourceSchema.cs` — add `@schema` entry to the source attr-schema

**Do not touch:**
- Conformance fixtures — already exist, behavior is verified by them passing
- TS metadata or any other language — this is C#-only catch-up

---

## Task 1: Add the `@schema` constant + `DEFAULT_DB_SCHEMA_POSTGRES`

**Files:**
- Modify: `server/csharp/MetaObjects/Persistence/Source/SourceConstants.cs`

- [ ] **Step 1: Add the constants**

Open `server/csharp/MetaObjects/Persistence/Source/SourceConstants.cs` (created by Plan A). Find the end of the file. Append:

```csharp
    /// <summary>
    /// Optional DB schema attr on source[dbTable] / source[dbView]. Postgres uses this to
    /// namespace tables/views. SQLite has no schema concept and treats any non-default value
    /// as an error at the TS migrate-ts emit boundary. C# loader carries this attr through;
    /// downstream tooling (when it ships) is responsible for dialect-specific behavior.
    /// </summary>
    public const string ATTR_SCHEMA = "schema";

    /// <summary>
    /// Default Postgres schema when @schema is omitted from a source.
    /// </summary>
    public const string DEFAULT_DB_SCHEMA_POSTGRES = "public";
```

- [ ] **Step 2: Build**

```bash
cd server/csharp && dotnet build
```

Expected: build clean (no errors — constants are pure additions).

- [ ] **Step 3: Commit**

```bash
git add server/csharp/MetaObjects/Persistence/Source/SourceConstants.cs
git commit -m "feat(csharp/metadata): add SOURCE.ATTR_SCHEMA + DEFAULT_DB_SCHEMA_POSTGRES constants"
```

---

## Task 2: Add `@schema` to the source attr-schema

**Files:**
- Modify: `server/csharp/MetaObjects/Persistence/Source/SourceSchema.cs`

- [ ] **Step 1: Add the schema entry**

Open `server/csharp/MetaObjects/Persistence/Source/SourceSchema.cs` (created by Plan A). The file should have a `SourceAttrs` or similar IReadOnlyList<AttrSchema>. Find the existing `@name` entry — the new `@schema` entry sits beside it.

Add (adapt to the exact `AttrSchema` constructor signature used by the project — verify by reading the file first):

```csharp
new AttrSchema(
    name: SourceConstants.ATTR_SCHEMA,
    valueType: AttrConstants.SUBTYPE_STRING,
    required: false,
    description:
        "DB schema for source[dbTable] / source[dbView]. Postgres default 'public' is " +
        "implied when omitted. SQLite-targeted emit rejects non-default values.")
```

Insert into the `SourceAttrs` collection so both `@name` and `@schema` are declared on `source[dbTable]` and `source[dbView]`. If the schema is split per-subtype (separate `DbTableAttrs` and `DbViewAttrs`), add the entry to BOTH.

- [ ] **Step 2: Build + test**

```bash
cd server/csharp && dotnet build && dotnet test MetaObjects.Conformance.Tests
```

Expected: build clean, 168 / 0 fail conformance. The three schema-namespacing fixtures (`source-db-table-with-schema/`, `source-db-view-with-schema/`, `source-db-table-default-schema-omitted/`) now exercise the declared schema instead of opaque passthrough — but the canonical output is unchanged, so conformance stays green.

- [ ] **Step 3: Commit**

```bash
git add server/csharp/MetaObjects/Persistence/Source/SourceSchema.cs
git commit -m "feat(csharp/metadata): declare @schema attr in source schema (matches TS first-class support)"
```

---

## Task 3: Verify the conformance fixtures pass via declared attr (not just opaque passthrough)

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm the three fixtures are exercising the declared schema**

```bash
cd server/csharp && dotnet test MetaObjects.Conformance.Tests --filter "FullyQualifiedName~source-db" 2>&1 | tail -10
```

Expected: each fixture passes. The pass count for these three should reflect both `Lint` and `Conformance` checks (typically 6 total — 3 fixtures × 2 checks).

- [ ] **Step 2: Sanity-check that an UNKNOWN value would be rejected**

Create a quick test that loads metadata declaring `@schema` with an INT value (not a string). The loader should now emit an error tied to the `AttrSchema` `valueType` validation, since `@schema` is no longer opaque.

(Optional — only if the C# project has an `attr-schema-validate` style test harness. Skip if conformance is the only verification surface.)

- [ ] **Step 3: No code change → no commit**

If verification passed, the task is complete with no new commit. If a sanity-check test was added under `MetaObjects.Tests/`, commit it as `test(csharp/metadata): verify @schema attr-schema rejects non-string values`.

---

## Self-Review

**1. Spec coverage**

The schema-namespacing feature in TS has three artifacts on the metadata side:
- `SOURCE_ATTR_SCHEMA` constant ✓ Task 1
- `DEFAULT_DB_SCHEMA_POSTGRES` constant ✓ Task 1
- `@schema` schema entry on `source[dbTable]` + `source[dbView]` ✓ Task 2

C# does NOT need the migrate-ts pipeline changes (introspect / diff / emit) because that pipeline doesn't exist in C# yet — those land via the larger C# tool plan.

**2. Placeholder scan**

The only "verify by reading the file" prompt is Task 2 Step 1 for the `AttrSchema` constructor signature — necessary because Plan A creates the file but the exact API may not be settled until that plan executes. Not a blocker; implementer reads the file when this plan runs.

**3. Scope check**

Tiny plan — 2 substantive tasks + 1 verification. ~30 minutes once Plan A is in place.

**4. Dependency check**

This plan REQUIRES Plan A to have landed because `Persistence/Source/SourceConstants.cs` and `SourceSchema.cs` don't exist until Plan A runs. If executed before Plan A, redirect Task 1 + 2 to add the constants/entries inline in `Constants.cs` + `CoreAttrSchemas.cs` (the monolithic files) instead.

---

## Done When

- `SourceConstants.cs` exports `ATTR_SCHEMA` and `DEFAULT_DB_SCHEMA_POSTGRES`
- `SourceSchema.cs` declares the `@schema` attr on source[dbTable] and source[dbView]
- `dotnet test MetaObjects.Conformance.Tests` is 168 / 0 fail
- The three schema-namespacing conformance fixtures exercise declared-attr validation, not opaque passthrough
