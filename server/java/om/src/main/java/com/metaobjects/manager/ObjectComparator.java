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

import com.metaobjects.MetaDataException;
import com.metaobjects.field.MetaField;
import com.metaobjects.util.MetaDataUtil;
import com.metaobjects.manager.exp.SortOrder;
import com.metaobjects.object.MetaObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Comparator;
import java.util.Date;

public class ObjectComparator implements Comparator<Object>
{
  private static final Logger log = LoggerFactory.getLogger(ObjectComparator.class);

  private SortOrder mSort = null;

  public ObjectComparator( SortOrder sort )
  {
    mSort = sort;
  }

  public int compare( Object a, Object b )
  {
    try {
      return performCompare( a, b, mSort );
    }
    catch( MetaDataException e ) {
      log.error( e.getMessage(), e );
      return 0;
    }
  }

  private int performCompare( Object a, Object b, SortOrder sort )
    throws MetaDataException
  {
    int rc = 0;

    if ( sort == null ) return 0;

    MetaObject ma = MetaDataUtil.findMetaObject( a, this );
    MetaObject mb = MetaDataUtil.findMetaObject( b, this );

    if ( !ma.equals( mb ))
      throw new MetaDataException( "Objects are not of the same MetaClass: [" + ma + "] != [" + mb + "]" );

    MetaField mf = ma.getMetaField( sort.getField() );

    //try
    //{
      Object aVal = mf.getObject( a );
      Object bVal = mf.getObject( b );

      if( aVal == null && bVal == null )
        rc = 0;
      else if ( aVal == null && bVal != null )
        rc = -1;
      else if ( aVal != null && bVal == null )
        rc = 1;
      else
      {
        if ( !aVal.getClass().equals( bVal.getClass() ))
          throw new MetaDataException( "Object data values are not of the same type" );

        switch( mf.getDataType() )
        {
          case BOOLEAN:
          {
            if ( !((Boolean) aVal ).booleanValue() && ((Boolean) bVal ).booleanValue() ) rc = -1;
            else if ( ((Boolean) aVal ).booleanValue() == ((Boolean) bVal ).booleanValue() ) rc = 0;
            else if ( ((Boolean) aVal ).booleanValue() && !((Boolean) bVal ).booleanValue() ) rc = 1;
            break;
          }
          case BYTE:    rc = ((Byte) aVal ).compareTo( (Byte) bVal ); break;
          case SHORT:   rc = ((Short) aVal ).compareTo( (Short) bVal ); break;
          case INT:     rc = ((Integer) aVal ).compareTo( (Integer) bVal ); break;
          case LONG:    rc = ((Long) aVal ).compareTo( (Long) bVal ); break;
          case FLOAT:   rc = ((Float) aVal ).compareTo( (Float) bVal ); break;
          case DOUBLE:  rc = ((Double) aVal ).compareTo( (Double) bVal ); break;
          case DECIMAL: rc = ((java.math.BigDecimal) aVal ).compareTo( (java.math.BigDecimal) bVal ); break;
          case STRING:  rc = ((String) aVal ).compareToIgnoreCase( (String) bVal ); break;
          case DATE:    rc = ((Date) aVal ).compareTo( (Date) bVal ); break;

          // WARN:  Maybe try some reflection here or something for a compareTo operator
          case OBJECT:  rc = aVal.toString().compareTo( bVal.toString() ); break;
        }
      }
    //}
    //catch( Exception e ) {
    //  log.warn( "Error comparing field [" + a + "] with [" + b + "] for sort [" + sort + "]: " + e.getMessage(), e );
    //}

    if ( rc == 0 )
    {
      if ( sort.hasNext() ) rc = performCompare( a, b, sort.getNext() );
    }
    else
    {
      // If descending, then reverse the order
      if ( sort.getOrder() == SortOrder.DESC )
        rc = -rc;
    }

    return rc;
  }
}
