// CSharpNaming — field-subtype → C# scalar binding.
//
// These pin the engine-independent native-type binding that survived the
// migrate-engine removal: the logical field subtype maps to a fixed C# type
// regardless of any physical @dbColumnType override (ADR-0013).

using MetaObjects.Codegen;
using static MetaObjects.Core.Field.FieldConstants;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class CSharpNamingTests
{
    [Fact]
    public void Field_uuid_binds_to_native_Guid()
    {
        Assert.Equal("Guid", CSharpNaming.ScalarFor(FIELD_SUBTYPE_UUID));
        Assert.True(CSharpNaming.IsValueType("Guid"));
    }

    [Fact]
    public void Field_string_stays_a_string_native_binding()
    {
        // The logical subtype field.string → C# `string`, even when a physical
        // @dbColumnType:uuid override shifts only the DB column type (ADR-0013).
        Assert.Equal("string", CSharpNaming.ScalarFor(FIELD_SUBTYPE_STRING));
    }
}
