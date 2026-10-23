package acme;

import jakarta.validation.constraints.*;
import com.fasterxml.jackson.annotation.JsonInclude;

/** GENERATED — value object SubscriberBlurbPayload. Do not hand-edit; regenerated from metadata. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SubscriberBlurbPayload(
    String name,
    @NotNull Status status
) {
    public enum Status { active, paused, cancelled }

    /** A fluent builder, so a caller can set a subset of the components. */
    public static Builder builder() { return new Builder(); }

    /** Builds a {@link SubscriberBlurbPayload}; an unset component stays null. */
    public static final class Builder {
        private String name;
        private Status status;

        private Builder() {}

        public Builder name(String v) { this.name = v; return this; }
        public Builder status(Status v) { this.status = v; return this; }

        public SubscriberBlurbPayload build() { return new SubscriberBlurbPayload(name, status); }
    }
}
