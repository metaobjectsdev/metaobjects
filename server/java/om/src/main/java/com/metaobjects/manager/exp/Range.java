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

public class Range
{
  private int mStart = 0;
  private int mEnd = 0;

  public Range( int start, int end )
  {
    setStart( start );
    setEnd( end );
  }

  public int getStart()
  {
    return mStart;
  }

  public void setStart( int start )
  {
    if ( start < 1 ) start = 1;
    mStart = start;
  }

  public int getEnd()
  {
    return mEnd;
  }

  public void setEnd( int end )
  {
    if ( end < 1 ) end = 1;
    mEnd = end;
  }

  public String toString()
  {
    return "FROM " + getStart() + " TO " + getEnd();
  }
}
