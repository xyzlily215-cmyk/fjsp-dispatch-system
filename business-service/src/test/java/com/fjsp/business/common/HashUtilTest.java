package com.fjsp.business.common;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HashUtilTest {

    @Test
    void sha256_knownValue() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                HashUtil.sha256("abc"));
    }

    @Test
    void sha256_hexLowercase64Chars() {
        String hash = HashUtil.sha256("任意文本");
        assertEquals(64, hash.length());
        assertTrue(hash.matches("[0-9a-f]{64}"));
    }

    @Test
    void sha256OfJson_independentOfMapKeyOrder() {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("mode", "BASELINE");
        a.put("orders", List.of("ORD-1", "ORD-2"));
        a.put("freezeWindowMinutes", 30);

        Map<String, Object> b = new LinkedHashMap<>();
        b.put("freezeWindowMinutes", 30);
        b.put("orders", List.of("ORD-1", "ORD-2"));
        b.put("mode", "BASELINE");

        assertEquals(HashUtil.sha256OfJson(a), HashUtil.sha256OfJson(b));
    }

    @Test
    void sha256OfJson_sensitiveToContent() {
        Map<String, Object> a = Map.of("mode", "BASELINE");
        Map<String, Object> b = Map.of("mode", "FULL_RESCHEDULE");

        assertNotEquals(HashUtil.sha256OfJson(a), HashUtil.sha256OfJson(b));
    }

    @Test
    void sha256OfJson_deterministic() {
        Map<String, Object> value = Map.of("k", List.of(1, 2, 3));
        assertEquals(HashUtil.sha256OfJson(value), HashUtil.sha256OfJson(value));
    }
}
