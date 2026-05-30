using MetaObjects.Codegen.Migrate;
using Xunit;

namespace MetaObjects.Codegen.Tests.Migrate;

public class SqlTypeTests
{
    [Fact]
    public void Record_equality_is_structural()
    {
        Assert.Equal(new SqlType.Text(10), new SqlType.Text(10));
        Assert.NotEqual<SqlType>(new SqlType.Text(10), new SqlType.Text(20));
        Assert.NotEqual<SqlType>(new SqlType.Text(), new SqlType.Text(10));
        Assert.Equal(new SqlType.Integer(64), new SqlType.Integer(64));
        Assert.NotEqual<SqlType>(new SqlType.Integer(32), new SqlType.Integer(64));
        Assert.Equal<SqlType>(new SqlType.Real(), new SqlType.Real());
        Assert.Equal<SqlType>(new SqlType.Real4(), new SqlType.Real4());
        Assert.NotEqual<SqlType>(new SqlType.Real(), new SqlType.Real4());  // float8 ≠ float4
        Assert.NotEqual<SqlType>(new SqlType.Timestamp(true), new SqlType.Timestamp(false));
        Assert.NotEqual<SqlType>(new SqlType.Integer(32), new SqlType.Real());
    }

    [Fact]
    public void Identical_types_are_not_widening()
    {
        Assert.False(SqlType.IsWidening(new SqlType.Integer(32), new SqlType.Integer(32)));
        Assert.False(SqlType.IsWidening(new SqlType.Text(10), new SqlType.Text(10)));
    }

    [Fact]
    public void Text_widening_rules()
    {
        Assert.False(SqlType.IsWidening(new SqlType.Text(), new SqlType.Text(10)));   // unbounded→bounded: lossy
        Assert.True(SqlType.IsWidening(new SqlType.Text(10), new SqlType.Text()));    // bounded→unbounded: widening
        Assert.True(SqlType.IsWidening(new SqlType.Text(10), new SqlType.Text(20)));  // grow: widening
        Assert.False(SqlType.IsWidening(new SqlType.Text(20), new SqlType.Text(10))); // shrink: lossy
    }

    [Fact]
    public void Integer_widening_rules()
    {
        Assert.True(SqlType.IsWidening(new SqlType.Integer(32), new SqlType.Integer(64)));
        Assert.False(SqlType.IsWidening(new SqlType.Integer(64), new SqlType.Integer(32)));
    }

    [Fact]
    public void Numeric_widening_requires_same_scale_and_nondecreasing_integer_digits()
    {
        Assert.True(SqlType.IsWidening(new SqlType.Numeric(10, 2), new SqlType.Numeric(12, 2)));
        Assert.False(SqlType.IsWidening(new SqlType.Numeric(10, 2), new SqlType.Numeric(10, 3))); // scale changed
        Assert.False(SqlType.IsWidening(new SqlType.Numeric(12, 2), new SqlType.Numeric(10, 2))); // precision shrank
    }

    [Fact]
    public void Cross_kind_change_is_never_widening()
    {
        Assert.False(SqlType.IsWidening(new SqlType.Integer(32), new SqlType.Text()));
        Assert.False(SqlType.IsWidening(new SqlType.Numeric(10, 2), new SqlType.Real()));
    }
}
