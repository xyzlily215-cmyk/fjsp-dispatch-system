package com.fjsp.business.auth;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

class StreamTicketServiceTest {

    private final StreamTicketService service = new StreamTicketService();

    @Test
    void issue_consume_roundTrip() {
        String ticket = service.issue("admin", "T-1");

        StreamTicketService.Ticket t = service.consume(ticket, "T-1");

        assertNotNull(t);
        assertEquals("admin", t.username());
        assertEquals("T-1", t.taskId());
    }

    @Test
    void consume_oneTime() {
        String ticket = service.issue("admin", "T-1");

        assertNotNull(service.consume(ticket, "T-1"));
        assertNull(service.consume(ticket, "T-1"), "ticket 只能消费一次");
    }

    @Test
    void consume_wrongTask_rejected() {
        String ticket = service.issue("admin", "T-1");

        assertNull(service.consume(ticket, "T-2"));
    }

    @Test
    void consume_unknownOrBlank_rejected() {
        assertNull(service.consume("no-such-ticket", "T-1"));
        assertNull(service.consume("", "T-1"));
        assertNull(service.consume(null, "T-1"));
    }

    @Test
    void issue_ticketsAreUnique() {
        assertNotEquals(service.issue("admin", "T-1"), service.issue("admin", "T-1"));
    }
}
