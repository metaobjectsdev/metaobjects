# Task 7 Report — C# port: index.lookup + drop identity.secondary @unique

## Status: COMPLETE

## Files Created

- `server/csharp/MetaObjects/Core/Index/IndexConstants.cs` — INDEX_SUBTYPE_LOOKUP, INDEX_ATTR_FIELDS constants
- `server/csharp/MetaObjects/Core/Index/IndexSchema.cs` — AttrSchema for @fields on index.lookup
- `server/csharp/MetaObjects/Meta/MetaIndex.cs` — MetaIndex node class with Fields() (ADR-0039 resolving accessor)
- `server/csharp/MetaObjects.Codegen.Tests/IndexLookupTests.cs` — 6 unit tests (happy-path, @unique rejected, ERR_INVALID_INDEX)

## Files Modified

- `server/csharp/MetaObjects/Shared/BaseTypes.cs` — added TYPE_INDEX = "index"
- `server/csharp/MetaObjects/GlobalUsings.cs` — added `global using static MetaObjects.Core.Index.IndexConstants`
- `server/csharp/MetaObjects/CoreTypes.cs` — registered index.lookup (TypeDefinition with description+whenToUse), added Wildcard(TYPE_INDEX) to objectRules, added IndexClassMap
- `server/csharp/MetaObjects/Persistence/Db/DbProvider.cs` — extend index.lookup with @orders/@where/@expr/@using; noted @unique intentionally not extended onto identity.secondary
- `server/csharp/MetaObjects/Core/Identity/IdentityConstants.cs` — removed IDENTITY_ATTR_UNIQUE constant
- `server/csharp/MetaObjects/Core/Identity/IdentitySchema.cs` — removed @unique from SecondaryIdentityAttrs
- `server/csharp/MetaObjects/Meta/MetaIdentity.cs` — removed Unique property
- `server/csharp/MetaObjects/Errors.cs` — added ERR_INVALID_INDEX
- `server/csharp/MetaObjects/Loader/ValidationPasses.cs` — added ValidateIndexLookupFields; also fixed array-valued allowedValues check (Check 3) to validate each element rather than the whole array (bug discovered: @orders ["asc","desc"] was triggering ERR_BAD_ATTR_VALUE)
- `server/csharp/MetaObjects/Loader/MetaDataLoader.cs` — wired ValidateIndexLookupFields into load pipeline
- `server/csharp/MetaObjects/SpecMetamodel/*.json` — copied updated spec files (object.json now has index.* child rule)

## Key Fix: allowedValues array element validation

The existing C# Check 3 (allowedValues membership) compared the entire array value against allowed values, which caused `ERR_BAD_ATTR_VALUE` for `@orders: ["asc", "desc"]` on `index.lookup`. Fixed to validate each element individually, matching the TS reference behavior.

## Test Results

- **MetaObjects.Conformance.Tests**: Passed 680/680 (0 failed)
  - registry-conformance: PASS (index.lookup registered with correct description/whenToUse/attrs; identity.secondary without @unique)
  - metadata conformance index-lookup: PASS
  - metadata conformance index-lookup-basic: PASS
- **MetaObjects.Codegen.Tests**: Passed 265/265, Skipped 1 (expected)
  - IndexLookupTests (6 tests): all PASS

## EF codegen check

Confirmed: no EF codegen code reads `identity.secondary` uniqueness. The only consumer of `MetaIdentity.Unique` was `MetaIdentity.cs` itself, and that property is removed. No EF model changes needed.
