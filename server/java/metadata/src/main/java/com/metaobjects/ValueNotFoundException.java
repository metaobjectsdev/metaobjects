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
package com.metaobjects;

/**
 * This exception should be thrown when an expected value
 * is not found.
 */
@SuppressWarnings("serial")
public class ValueNotFoundException extends ValueException  {

  public ValueNotFoundException( String msg, Throwable t )
  {
    super( msg, t );
  }
  public ValueNotFoundException( String msg )
  {
    super( msg );
  }
}
