/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */

package com.metaobjects;

import com.metaobjects.util.MetaDataPath;

import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * Enhanced MetaDataException with structured context information for better error reporting.
 * Maintains full backward compatibility while providing rich contextual information.
 * 
 * <p>Basic usage (backward compatible):</p>
 * <pre>
 * throw new MetaDataException("Something went wrong");
 * </pre>
 * 
 * <p>Enhanced usage with context:</p>
 * <pre>
 * throw new MetaDataException("Validation failed", metaField, "validation", 
 *     Map.of("expectedType", "string", "actualValue", value));
 * </pre>
 * 
 * @since 1.0 (enhanced in 5.2.0)
 */
@SuppressWarnings("serial")
public class MetaDataException extends RuntimeException {

    private final MetaDataPath metaDataPath;
    private final String operation;
    private final Map<String, Object> context;
    private final long timestamp;
    private final String threadName;

    /**
     * Structured error code — {@code null} when the exception was constructed via one of
     * the legacy message-only constructors (backward-compatible callers that embed the code
     * string in the message).  Migration of those sites is incremental; only the enum
     * validation path sets this in the first phase.
     */
    private final ErrorCode code;

    /**
     * Creates a MetaDataException with a simple message.
     * Backward compatible constructor.
     *
     * @param msg the error message
     */
    public MetaDataException(String msg) {
        this(msg, (ErrorCode) null);
    }

    /**
     * Creates a MetaDataException with a message and a structured error code.
     *
     * <p>Use this constructor in new code that needs machine-readable error codes.
     * The {@code code} is accessible via {@link #getCode()}.</p>
     *
     * @param msg  the error message (may still embed the code string for backward compat)
     * @param code the structured {@link ErrorCode}; {@code null} if not applicable
     */
    public MetaDataException(String msg, ErrorCode code) {
        this(msg, null, null, null, Collections.emptyMap(), code);
    }

    /**
     * Creates a MetaDataException with a message and cause.
     * Backward compatible constructor.
     *
     * @param msg the error message
     * @param cause the underlying cause
     */
    public MetaDataException(String msg, Throwable cause) {
        this(msg, null, null, cause, Collections.emptyMap(), null);
    }

    /**
     * Creates a MetaDataException with enhanced context information.
     *
     * @param message the error message
     * @param source the MetaData object where the error occurred (may be null)
     * @param operation the operation being performed when the error occurred (may be null)
     */
    public MetaDataException(String message, MetaData source, String operation) {
        this(message, source, operation, null, Collections.emptyMap(), null);
    }

    /**
     * Creates a MetaDataException with full context information.
     *
     * @param message the error message
     * @param source the MetaData object where the error occurred (may be null)
     * @param operation the operation being performed when the error occurred (may be null)
     * @param cause the underlying cause (may be null)
     * @param additionalContext additional context information (may be empty)
     */
    public MetaDataException(String message, MetaData source, String operation,
                           Throwable cause, Map<String, Object> additionalContext) {
        this(message, source, operation, cause, additionalContext, null);
    }

    /**
     * Full internal constructor — all fields including the structured error code.
     *
     * @param message           the error message
     * @param source            the MetaData object where the error occurred (may be null)
     * @param operation         the operation being performed when the error occurred (may be null)
     * @param cause             the underlying cause (may be null)
     * @param additionalContext additional context information (may be empty)
     * @param code              the structured {@link ErrorCode}; {@code null} if not applicable
     */
    public MetaDataException(String message, MetaData source, String operation,
                           Throwable cause, Map<String, Object> additionalContext,
                           ErrorCode code) {
        super(buildEnhancedMessage(message, source, operation, additionalContext), cause);

        this.code = code;
        this.metaDataPath = source != null ? MetaDataPath.buildPath(source) : null;
        this.operation = operation;
        this.context = new LinkedHashMap<>(additionalContext != null ? additionalContext : Collections.emptyMap());
        this.timestamp = System.currentTimeMillis();
        this.threadName = Thread.currentThread().getName();

        // Add automatic context if source is available
        if (source != null) {
            this.context.put("sourceClass", source.getClass().getSimpleName());
            this.context.put("sourceType", source.getType());
            this.context.put("sourceSubType", source.getSubType());
            this.context.put("sourceName", source.getName());
        }
    }

    /**
     * Builds an enhanced error message with context information.
     * 
     * @param message the base message
     * @param source the source MetaData object
     * @param operation the operation being performed
     * @param context additional context
     * @return enhanced message with context details
     */
    private static String buildEnhancedMessage(String message, MetaData source,
                                             String operation, Map<String, Object> context) {
        StringBuilder enhanced = new StringBuilder();
        enhanced.append(message);

        // Only add details if we have enhanced context
        if (source != null || operation != null || (context != null && !context.isEmpty())) {
            enhanced.append("\n\n--- Error Details ---");

            if (source != null) {
                enhanced.append("\nPath: ").append(MetaDataPath.buildPath(source).toHierarchicalString());
            }

            if (operation != null) {
                enhanced.append("\nOperation: ").append(operation);
            }

            enhanced.append("\nThread: ").append(Thread.currentThread().getName());
            enhanced.append("\nTimestamp: ").append(Instant.ofEpochMilli(System.currentTimeMillis()));

            if (context != null && !context.isEmpty()) {
                enhanced.append("\nContext:");
                context.forEach((key, value) ->
                    enhanced.append("\n  ").append(key).append(": ").append(value));
            }
        }

        return enhanced.toString();
    }

    /**
     * Returns the structured error code attached to this exception.
     *
     * <p>Returns {@code Optional.empty()} for exceptions constructed via the legacy
     * message-only constructors that embed the code string in the message text.
     * Migration to structured codes is incremental.</p>
     *
     * @return Optional containing the {@link ErrorCode}, or empty if none was set
     */
    public Optional<ErrorCode> getCode() {
        return Optional.ofNullable(code);
    }

    /**
     * Returns the hierarchical path to the MetaData object where this error occurred.
     *
     * @return Optional containing the MetaDataPath, or empty if no source was provided
     */
    public Optional<MetaDataPath> getMetaDataPath() {
        return Optional.ofNullable(metaDataPath);
    }

    /**
     * Returns the operation being performed when this error occurred.
     * 
     * @return Optional containing the operation name, or empty if no operation was provided
     */
    public Optional<String> getOperation() {
        return Optional.ofNullable(operation);
    }

    /**
     * Returns the context information associated with this error.
     * Includes both user-provided context and automatic context from the source MetaData.
     * 
     * @return unmodifiable map of context information
     */
    public Map<String, Object> getContext() {
        return Collections.unmodifiableMap(context);
    }

    /**
     * Returns the timestamp when this error occurred.
     * 
     * @return timestamp in milliseconds since epoch
     */
    public long getTimestamp() {
        return timestamp;
    }

    /**
     * Returns the name of the thread where this error occurred.
     * 
     * @return thread name
     */
    public String getThreadName() {
        return threadName;
    }

    /**
     * Returns a specific context value by key.
     * 
     * @param key the context key
     * @return Optional containing the value, or empty if not found
     */
    public Optional<Object> getContextValue(String key) {
        return Optional.ofNullable(context.get(key));
    }

    /**
     * Checks if this exception has enhanced context information.
     * 
     * @return true if this exception has enhanced context (path, operation, or additional context)
     */
    public boolean hasEnhancedContext() {
        return metaDataPath != null || operation != null || !context.isEmpty();
    }
}
