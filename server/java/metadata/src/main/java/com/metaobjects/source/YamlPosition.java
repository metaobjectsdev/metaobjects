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
package com.metaobjects.source;

/**
 * Optional YAML source position (FR5b reserved slot).
 *
 * <p>Lines and columns are 1-based, matching the YAML spec and most editors.
 * Mirrors {@code YamlPosition} in
 * {@code server/csharp/MetaObjects/Source/ErrorSource.cs}.</p>
 *
 * @param line 1-based line number in the YAML source
 * @param col 1-based column number in the YAML source
 */
public record YamlPosition(int line, int col) {
}
