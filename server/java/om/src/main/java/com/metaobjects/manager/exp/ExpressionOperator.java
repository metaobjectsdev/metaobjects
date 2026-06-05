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

public class ExpressionOperator extends Expression
{
  public final static int AND = 0;
  public final static int OR  = 1;

  private Expression mExpA = null;
  private Expression mExpB = null;
  private int mOper = AND;

  ExpressionOperator( Expression expA, Expression expB, int oper )
  {
    mExpA = expA;
    mExpB = expB;
    mOper = oper;
  }

  public Expression getExpressionA()
  {
    return mExpA;
  }

  public Expression getExpressionB()
  {
    return mExpB;
  }

  public int getOperator()
  {
    return mOper;
  }

  public String toString()
  {
    String c = " AND ";
    if ( getOperator() == OR ) c = " OR ";
    return getExpressionA() + c + getExpressionB();
  }
}
