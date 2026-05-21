// ValidationTests — targeted tests for each validation pass.
//
// These tests complement the ConformanceTests Theory: each fixture exercising
// a validation pass is also directly targeted here with a named test so that
// failure messages name the failing pass.

using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ValidationTests
{
    private static LoadResult Load(string fixture) =>
        new FileMetaDataLoader().LoadDirectory(
            System.IO.Path.Combine(CorpusRoot.Path, fixture, "input"));

    [Fact]
    public void Bad_default_sort_field_is_an_error()
        => Assert.Contains(Load("error-data-grid-bad-sort-field").Errors,
            e => e.Code == ErrorCode.ERR_BAD_DEFAULT_SORT_FIELD);

    [Fact]
    public void Filterable_without_index_is_a_warning()
        => Assert.NotEmpty(Load("warning-filterable-no-index").Warnings);

    [Fact]
    public void Bad_via_path_is_an_origin_error()
        => Assert.Contains(Load("error-origin-bad-via-path").Errors,
            e => e.Code == ErrorCode.ERR_INVALID_ORIGIN);

    [Fact]
    public void Attr_required_missing_is_an_error()
        => Assert.Contains(Load("error-attr-missing-required").Errors,
            e => e.Code == ErrorCode.ERR_MISSING_REQUIRED_ATTR);
}
