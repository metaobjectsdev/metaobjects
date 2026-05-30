package com.metaobjects.manager.exp.parser;

import com.metaobjects.field.IntegerField;
import com.metaobjects.field.StringField;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.object.EntityMetaObject;
import com.metaobjects.object.MetaObject;
import org.junit.Assert;
import org.junit.Before;
import org.junit.Test;

/**
 * Regression tests for {@link ExpressionParser}: it previously lower-cased the entire
 * query string, corrupting quoted literals and making the {@code NULL} sentinel
 * unreachable. Only the {@code and}/{@code or} keywords are matched case-insensitively;
 * field identifiers and literal values preserve their original case.
 */
public class ExpressionParserCaseTest {

    private MetaObject mc;

    @Before
    public void setUp() {
        mc = new EntityMetaObject("test");
        mc.addMetaField(new StringField("name"));
        mc.addMetaField(new IntegerField("value"));
    }

    @Test
    public void preservesMixedCaseStringLiteral() throws ExpressionParseError {
        Expression exp = ExpressionParser.getInstance().parse(mc, "name = 'Test Me'");

        Assert.assertEquals("name", exp.getField());
        Assert.assertEquals("string value preserves original case", "Test Me", exp.getValue());
        Assert.assertEquals(Expression.EQUAL, exp.getCondition());
    }

    @Test
    public void nullSentinelProducesNullValuedExpression() throws ExpressionParseError {
        Expression exp = ExpressionParser.getInstance().parse(mc, "name = NULL");

        Assert.assertEquals("name", exp.getField());
        Assert.assertNull("NULL sentinel yields a null value", exp.getValue());
    }

    @Test
    public void andKeywordIsCaseInsensitive() throws ExpressionParseError {
        Expression exp = ExpressionParser.getInstance().parse(mc, "( name = 'Foo' AND value = 5 )");

        // A grouped/compound expression is returned without error.
        Assert.assertNotNull(exp);
    }

    @Test
    public void orKeywordIsCaseInsensitive() throws ExpressionParseError {
        Expression exp = ExpressionParser.getInstance().parse(mc, "( name = 'Foo' Or value = 5 )");

        Assert.assertNotNull(exp);
    }
}
