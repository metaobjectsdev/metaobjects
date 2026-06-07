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

package com.metaobjects.manager;

import java.util.Collection;

import com.metaobjects.field.MetaField;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.manager.exp.Range;
import com.metaobjects.manager.exp.SortOrder;

/**
 * Provides a mechanism to pass options into object requests
 *  for the ObjectManagers.
 */
public class QueryOptions
{
  private boolean mDistinct      = false;
  private Expression mExp        = null;
  private SortOrder mOrder       = null;
  private Range mRange           = null;
  private Collection<MetaField> mFields      = null;
  private boolean mWithLock		 = false;

  public QueryOptions()
  {
  }

  public QueryOptions( Expression exp )
  {
    this( exp, null );
  }

  public QueryOptions( Expression exp, SortOrder order )
  {
    this( exp, order, null );
  }

  public QueryOptions( Expression exp, SortOrder order, Range range )
  {
    setExpression( exp );
    setSortOrder( order );
    setRange( range );
  }

  public void setExpression( Expression exp )
  {
    mExp = exp;
  }

  public Expression getExpression()
  {
    return mExp;
  }

  public void setSortOrder( SortOrder order )
  {
    mOrder = order;
  }

  public SortOrder getSortOrder()
  {
    return mOrder;
  }

  public void setRange( int start, int end )
  {
    mRange = new Range( start, end );
  }

  public void setRange( Range range )
  {
    mRange = range;
  }

  public Range getRange()
  {
    return mRange;
  }

  public void setDistinct( boolean distinct )
  {
    mDistinct = distinct;
  }

  public boolean isDistinct()
  {
    return mDistinct;
  }

  public void setFields( Collection<MetaField> fields )
  {
    mFields = fields;
  }

  public Collection<MetaField> getFields()
  {
    return mFields;
  }

  public String toString()
  {
    return "Options{ EXP: " + getExpression() + "; ORDER: " + getSortOrder() + "; RANGE: " + getRange() + " }";
  }

  /** If the records read should be locked from updates for this transaction */
  public boolean withLock() {
	return mWithLock;
  }
	
  /** Whether to lock the records being read from updates for this transaction */
  public void setWithLock(boolean withLock) {
	this.mWithLock = withLock;
  }
}
