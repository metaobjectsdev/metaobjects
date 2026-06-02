using Xunit;

namespace MetaObjects.Render.Tests;

/// <summary>The <see cref="EmailDocument"/> value type (subject + HTML body + optional text body).</summary>
public class EmailDocumentTests
{
    [Fact]
    public void Constructs_with_default_null_text_body()
    {
        var email = new EmailDocument("s", "h");
        Assert.Equal("s", email.Subject);
        Assert.Equal("h", email.HtmlBody);
        Assert.Null(email.TextBody);
    }

    [Fact]
    public void Constructs_with_text_body()
    {
        var email = new EmailDocument("s", "h", "t");
        Assert.Equal("s", email.Subject);
        Assert.Equal("h", email.HtmlBody);
        Assert.Equal("t", email.TextBody);
    }
}
