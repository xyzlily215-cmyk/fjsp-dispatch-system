package com.fjsp.business.controller;

import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Optional;

import com.fjsp.business.auth.JwtAuthenticationFilter;
import com.fjsp.business.auth.JwtService;
import com.fjsp.business.auth.StreamTicketService;
import com.fjsp.business.common.BizException;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.config.SecurityConfig;
import com.fjsp.business.entity.AppUser;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.AppUserRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import com.fjsp.business.service.TaskEventService;
import com.fjsp.business.service.TaskService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import static org.hamcrest.Matchers.containsString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** SSE 进度端点：订阅鉴权、状态推送、终态关流；EventSource 的一次性 ?ticket= 查询参数认证。 */
@WebMvcTest(controllers = ScheduleTaskController.class,
        properties = "fjsp.auth.jwt-secret=test-jwt-secret-test-jwt-secret-123456")
@Import({SecurityConfig.class, JwtAuthenticationFilter.class, JwtService.class,
        ScheduleTaskSseTest.TestBeans.class})
class ScheduleTaskSseTest {

    @TestConfiguration
    static class TestBeans {
        @Bean
        FjspProperties fjspProperties() {
            FjspProperties properties = new FjspProperties();
            properties.getAuth().setJwtSecret("test-jwt-secret-test-jwt-secret-123456");
            properties.getAuth().setTokenTtl(Duration.ofHours(8));
            return properties;
        }
    }

    @Autowired
    private MockMvc mvc;
    @Autowired
    private JwtService jwtService;
    @MockitoBean
    private TaskService taskService;
    @MockitoBean
    private TaskEventService taskEventService;
    @MockitoBean
    private AppUserRepository userRepository;
    @MockitoBean
    private StreamTicketService streamTicketService;

    private String token(String username, String role) {
        // 过滤器实时查库校验启用状态与 tokenVersion：返回与 JWT tv claim（默认 0）一致的启用用户
        AppUser user = new AppUser();
        user.setUsername(username);
        user.setRole(role);
        when(userRepository.findByUsername(username)).thenReturn(Optional.of(user));
        return jwtService.generateToken(user);
    }

    private ScheduleTask task(String status) {
        ScheduleTask task = new ScheduleTask();
        task.setId("t1");
        task.setTaskCode("TSK-001");
        task.setMode("BASELINE");
        task.setStatus(status);
        task.setProgress("PENDING".equals(status) ? 0 : 10);
        task.setStartedAt(OffsetDateTime.now().minusSeconds(3));
        return task;
    }

    @Test
    void events_unauthenticated_401() throws Exception {
        mvc.perform(get("/api/v1/schedule-tasks/t1/events"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("E_UNAUTHORIZED"));
    }

    @Test
    void events_unknownTask_404() throws Exception {
        when(taskService.findTask("nope")).thenThrow(BizException.notFound("任务不存在: nope"));

        mvc.perform(get("/api/v1/schedule-tasks/nope/events")
                        .header("Authorization", "Bearer " + token("dispatcher", "DISPATCHER")))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("E_NOT_FOUND"));
    }

    @Test
    void events_terminalTask_sendsSnapshotAndCompletes() throws Exception {
        ScheduleTask success = task("SUCCESS");
        success.setFinishedAt(OffsetDateTime.now());
        when(taskService.findTask("t1")).thenReturn(success);
        TaskEventService realService = new TaskEventService(
                mock(ScheduleTaskRepository.class), new FjspProperties());
        when(taskEventService.subscribe(any())).thenAnswer(inv -> realService.subscribe(inv.getArgument(0)));

        mvc.perform(get("/api/v1/schedule-tasks/t1/events")
                        .header("Authorization", "Bearer " + token("dispatcher", "DISPATCHER")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_EVENT_STREAM_VALUE))
                .andExpect(content().string(containsString("event:progress")))
                .andExpect(content().string(containsString("\"status\":\"SUCCESS\"")))
                .andExpect(content().string(containsString("\"terminal\":true")));
    }

    @Test
    void events_runningTask_pushesStatusChangeAndClosesOnTerminal() throws Exception {
        ScheduleTaskRepository repository = mock(ScheduleTaskRepository.class);
        TaskEventService realService = new TaskEventService(repository, new FjspProperties());
        ScheduleTask running = task("RUNNING");
        when(taskService.findTask("t1")).thenReturn(running);
        when(taskEventService.subscribe(any())).thenAnswer(inv -> realService.subscribe(inv.getArgument(0)));

        MvcResult result = mvc.perform(get("/api/v1/schedule-tasks/t1/events")
                        .header("Authorization", "Bearer " + token("reviewer", "REVIEWER")))
                .andExpect(request().asyncStarted())
                .andReturn();

        ScheduleTask success = task("SUCCESS");
        success.setProgress(100);
        success.setFinishedAt(OffsetDateTime.now());
        when(repository.findById("t1")).thenReturn(Optional.of(success));
        realService.publish("t1");

        mvc.perform(asyncDispatch(result))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_EVENT_STREAM_VALUE))
                .andExpect(content().string(containsString("event:progress")))
                .andExpect(content().string(containsString("\"status\":\"RUNNING\"")))
                .andExpect(content().string(containsString("\"status\":\"SUCCESS\"")))
                .andExpect(content().string(containsString("\"terminal\":true")));
    }

    @Test
    void events_ticketQueryParam_authenticated() throws Exception {
        ScheduleTask success = task("SUCCESS");
        success.setFinishedAt(OffsetDateTime.now());
        when(taskService.findTask("t1")).thenReturn(success);
        TaskEventService realService = new TaskEventService(
                mock(ScheduleTaskRepository.class), new FjspProperties());
        when(taskEventService.subscribe(any())).thenAnswer(inv -> realService.subscribe(inv.getArgument(0)));
        // SSE 端点只接受一次性 ?ticket=（不再接受 access_token 携带 JWT）
        AppUser user = new AppUser();
        user.setUsername("dispatcher");
        user.setRole("DISPATCHER");
        when(userRepository.findByUsername("dispatcher")).thenReturn(Optional.of(user));
        when(streamTicketService.consume("tk-1", "t1")).thenReturn(
                new StreamTicketService.Ticket("dispatcher", "t1", Instant.now().plusSeconds(60)));

        mvc.perform(get("/api/v1/schedule-tasks/t1/events")
                        .param("ticket", "tk-1"))
                .andExpect(status().isOk())
                .andExpect(content().string(containsString("event:progress")));
    }

    @Test
    void events_badTicketQueryParam_401() throws Exception {
        mvc.perform(get("/api/v1/schedule-tasks/t1/events")
                        .param("ticket", "not-a-ticket"))
                .andExpect(status().isUnauthorized());
    }
}
