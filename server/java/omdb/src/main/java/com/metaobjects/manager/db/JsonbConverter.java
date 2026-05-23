package com.metaobjects.manager.db;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.type.TypeFactory;
import java.util.List;
import java.util.Map;

/** Thin Jackson bridge: typed jsonb value-objects <-> jsonb text. */
public class JsonbConverter {
    private final ObjectMapper mapper = new ObjectMapper();

    public String toJson(Object value) {
        try { return mapper.writeValueAsString(value); }
        catch (Exception e) { throw new IllegalStateException("jsonb serialize failed", e); }
    }

    public <T> T fromJson(String json, Class<T> type) {
        try { return mapper.readValue(json, type); }
        catch (Exception e) { throw new IllegalStateException("jsonb deserialize failed", e); }
    }

    public <T> List<T> fromJsonList(String json, Class<T> elem) {
        try { return mapper.readValue(json,
                TypeFactory.defaultInstance().constructCollectionType(List.class, elem)); }
        catch (Exception e) { throw new IllegalStateException("jsonb list deserialize failed", e); }
    }

    public <K, V> Map<K, V> fromJsonMap(String json, Class<K> k, Class<V> v) {
        try { return mapper.readValue(json,
                TypeFactory.defaultInstance().constructMapType(Map.class, k, v)); }
        catch (Exception e) { throw new IllegalStateException("jsonb map deserialize failed", e); }
    }
}
