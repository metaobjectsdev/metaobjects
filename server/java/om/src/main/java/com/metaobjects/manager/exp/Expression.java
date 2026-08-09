/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.metaobjects.manager.exp;

import java.util.Date;

public class Expression
{
    public final static int EQUAL           = 0;
    public final static int NOT_EQUAL       = 1;
    public final static int GREATER         = 2;
    public final static int LESSER          = 3;
    public final static int EQUAL_GREATER   = 4;
    public final static int EQUAL_LESSER    = 5;

    public final static int CONTAIN         = 6;
    public final static int NOT_CONTAIN     = 7;
    public final static int START_WITH      = 8;
    public final static int NOT_START_WITH  = 9;
    public final static int END_WITH        = 10;
    public final static int NOT_END_WITH    = 11;
    public final static int EQUALS_IGNORE_CASE = 12;

    /**
     * Case-sensitive SQL {@code LIKE} with the pattern passed through VERBATIM — the
     * caller supplies its own {@code %} / {@code _} wildcards and controls anchoring.
     *
     * Distinct from {@link #CONTAIN} / {@link #START_WITH} / {@link #END_WITH}, which wrap
     * both column and value in {@code UPPER(...)} (case-INsensitive) and add the wildcards
     * themselves. Those cannot express the cross-port REST filter contract, whose
     * {@code like} operator is case-sensitive full SQL LIKE with author-supplied wildcards
     * — including interior ones ({@code "a%b"}) that the anchored conditions have no way
     * to represent at all.
     */
    public final static int LIKE            = 13;

    ///**
    // * @deprecated Replaced with CONTAIN
    // */
    //public final static int CONTAINS        = CONTAIN;

    private boolean mSpecial = false;
    private String field = null;
    private Object value = null;
    private int condition = EQUAL;

    protected Expression()
    {
        mSpecial = true;
    }

    public Expression( final String field, final Object value )
    {
        this( field, value, EQUAL );
    }

    public Expression( final String field, final Object value, final int condition )
    {
      setField( field );
      setValue( value );
      setCondition( condition );
    }

    public boolean isSpecial()
    {
        return mSpecial;
    }

    public int getCondition()
    {
        return condition;
    }

    public void setCondition( final int condition )
    {
        //if ( condition < EQUAL ) condition = EQUAL;
        //if ( condition > ENDS_WITH ) condition = ENDS_WITH;
        this.condition = condition;
    }

    public String getField()
    {
        return field;
    }

    public void setField( final String field )
    {
        this.field = field;
    }

    public Object getValue()
    {
        return value;
    }

    public void setValue( final Object value )
    {
      if ( value == null && condition != EQUAL && condition != NOT_EQUAL )
        throw new IllegalArgumentException( "A null value is only acceptable for EQUAL or NOT_EQUAL conditions" );

      this.value = value;
    }

    public Expression and( final Expression exp )
    {
        return new ExpressionOperator( this, exp, ExpressionOperator.AND );
    }

    public Expression or( final Expression exp )
    {
        return new ExpressionOperator( this, exp, ExpressionOperator.OR );
    }

    public Expression group()
    {
        return new ExpressionGroup( this );
    }

    public final static String condStr( int condition )
    {
        switch( condition )
        {
            case EQUAL:           return "=";
            case NOT_EQUAL:       return "!=";
            case GREATER:         return ">";
            case LESSER:          return "<";
            case EQUAL_GREATER:   return ">=";
            case EQUAL_LESSER:    return "<=";
            case CONTAIN:         return "C";
            case NOT_CONTAIN:     return "!C";
            case START_WITH:      return "S";
            case NOT_START_WITH:  return "!S";
            case END_WITH:        return "E";
            case NOT_END_WITH:    return "!E";
            case EQUALS_IGNORE_CASE:    return "(=)";
        }

        return "?" + condition + "?";
    }

    public String toString()
    {
    	StringBuilder sb = new StringBuilder();
    	
        sb.append( getField() ).append( " " ).append( condStr( getCondition() )).append( " " );
        if ( getValue() == null ) {
        	sb.append( "NULL" );
        }
        if ( getValue() instanceof String
            || getValue() instanceof Date ) {
        	sb.append( "'" ).append( getValue() ).append( "'" );
        }
        else sb.append( getValue() );

        return sb.toString();
    }
}
