/**
 * Spring Web MVC codegen target for MetaObjects (FR-008 §2.1).
 *
 * <p>Three generators ship in this package, each writing one Java file per
 * {@code object.entity}:</p>
 *
 * <ul>
 *   <li>{@link com.metaobjects.generator.spring.SpringControllerGenerator} —
 *       emits {@code <Entity>Controller.java} per writable entity (a
 *       {@code source.rdb} child with {@code @kind="table"}). Five CRUD
 *       endpoints (GET list / GET by id / POST / PATCH + PUT / DELETE),
 *       the cross-port {@code ?sort}, {@code ?limit/?offset},
 *       {@code ?withCount=1} envelope, and 404 + 400 envelopes per the
 *       contract.</li>
 *   <li>{@link com.metaobjects.generator.spring.SpringDtoGenerator} —
 *       emits {@code <Entity>Dto.java} as a Java 21 {@code record}, mirroring
 *       the entity field shape. Used as both request and response body so
 *       wire/JSON shape is fully isolated from persistence-entity shape.</li>
 *   <li>{@link com.metaobjects.generator.spring.SpringRepositoryGenerator} —
 *       emits {@code <Entity>Repository.java} as a hand-stubbed interface
 *       the consumer implements with their preferred persistence layer
 *       (JPA / jOOQ / JDBC — all out of MetaObjects' concern).</li>
 * </ul>
 *
 * <p>Targets Spring Boot 3.x / Java 21, Spring Web MVC (not WebFlux).
 * The generated controllers carry no compile-time MetaObjects dependency:
 * regenerated output runs with only Spring on the classpath.</p>
 *
 * <p>See the cross-port API contract at
 * {@code docs/features/api-contract.md} and FR-008 §2.1 at
 * {@code docs/superpowers/specs/2026-05-26-fr-008-universal-react-ui-hookup.md}.</p>
 *
 * <p><strong>Known gaps:</strong> filter operators
 * ({@code eq/ne/gt/gte/lt/lte/in/like/isNull}) are not yet wired through —
 * only {@code sort}, pagination, and the {@code withCount} envelope are
 * honoured today. See {@code KNOWN_GAPS.md} in this package.</p>
 */
package com.metaobjects.generator.spring;
