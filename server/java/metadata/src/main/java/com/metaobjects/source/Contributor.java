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
 * One contributor in a {@link MergedSource} (FR5c reserved slot).
 *
 * <p>Mirrors {@code Contributor} in
 * {@code server/csharp/MetaObjects/Source/ErrorSource.cs}.</p>
 *
 * @param file project-root-relative path with forward slashes
 * @param role one of {@code "overlay-base"} / {@code "overlay-extension"} /
 *             {@code "extends-base"} / {@code "extends-extension"}
 */
public record Contributor(String file, String role) {
}
