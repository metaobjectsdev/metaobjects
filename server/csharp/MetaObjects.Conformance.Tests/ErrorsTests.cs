using MetaObjects;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ErrorsTests
{
    [Fact]
    public void MetaError_carries_a_stable_code()
    {
        var e = new MetaError("bad metadata", ErrorCode.ERR_UNKNOWN_TYPE);
        Assert.Equal(ErrorCode.ERR_UNKNOWN_TYPE, e.Code);
        Assert.Equal("bad metadata", e.Message);
    }

    [Fact]
    public void ErrorCode_names_match_the_corpus_ledger()
    {
        Assert.Contains(ErrorCode.ERR_MALFORMED_JSON, System.Enum.GetValues<ErrorCode>());
        Assert.Contains(ErrorCode.ERR_OVERLAY_NO_TARGET, System.Enum.GetValues<ErrorCode>());
    }
}
