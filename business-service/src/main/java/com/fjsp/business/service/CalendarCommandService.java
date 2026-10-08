package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.CalendarIntervalCreatedResponse;
import com.fjsp.business.dto.CalendarIntervalDeletedResponse;
import com.fjsp.business.dto.CalendarIntervalRequest;
import com.fjsp.business.dto.CalendarIntervalResponse;
import com.fjsp.business.dto.CalendarVersionResponse;
import com.fjsp.business.entity.CalendarInterval;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.Machine;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.WorkCalendar;
import com.fjsp.business.repository.CalendarIntervalRepository;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.WorkCalendarRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** 设备日历（版本化，F-02） */
@Service
public class CalendarCommandService {

    private static final Set<String> INTERVAL_TYPES = Set.of("WORK", "BREAK", "HOLIDAY", "REPAIR");

    private final MachineRepository machineRepository;
    private final CalendarIntervalRepository calendarIntervalRepository;
    private final WorkCalendarRepository workCalendarRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final ExecutionRecordRepository executionRecordRepository;
    private final IdempotencyService idempotencyService;
    private final AuditService auditService;

    public CalendarCommandService(MachineRepository machineRepository,
                                  CalendarIntervalRepository calendarIntervalRepository,
                                  WorkCalendarRepository workCalendarRepository,
                                  ScheduleOperationRepository scheduleOperationRepository,
                                  ExecutionRecordRepository executionRecordRepository,
                                  IdempotencyService idempotencyService,
                                  AuditService auditService) {
        this.machineRepository = machineRepository;
        this.calendarIntervalRepository = calendarIntervalRepository;
        this.workCalendarRepository = workCalendarRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.executionRecordRepository = executionRecordRepository;
        this.idempotencyService = idempotencyService;
        this.auditService = auditService;
    }

    public List<CalendarIntervalResponse> listCalendarIntervals(String calendarId) {
        List<CalendarIntervalResponse> result = new ArrayList<>();
        for (CalendarInterval ci : calendarIntervalRepository.findByCalendarIdOrderByStartAt(calendarId)) {
            result.add(toResponse(ci));
        }
        return result;
    }

    /** 日历版本历史（新→旧）：入参可为该日历的任意版本 id；current 标记当前生效版本。 */
    public List<CalendarVersionResponse> listCalendarVersions(String calendarId) {
        WorkCalendar any = workCalendarRepository.findById(calendarId)
                .orElseThrow(() -> BizException.notFound("日历不存在: " + calendarId));
        List<WorkCalendar> versions = workCalendarRepository
                .findByCalendarCodeOrderByCalendarVersionDesc(any.getCalendarCode());
        List<CalendarVersionResponse> result = new ArrayList<>();
        for (int i = 0; i < versions.size(); i++) {
            WorkCalendar v = versions.get(i);
            result.add(new CalendarVersionResponse(v.getId(), v.getCalendarCode(),
                    v.getCalendarVersion(), v.getStatus(), i == 0, v.getChangeNote(), v.getCreatedAt()));
        }
        return result;
    }

    @Transactional
    public CalendarIntervalCreatedResponse addCalendarInterval(String idempotencyKey, String calendarId,
                                                               CalendarIntervalRequest req) {
        return idempotencyService.execute(idempotencyKey, req, () -> {
            if (req == null || req.intervalType() == null || !INTERVAL_TYPES.contains(req.intervalType())) {
                throw BizException.validation("intervalType 必须是 WORK / BREAK / HOLIDAY / REPAIR");
            }
            if (req.startAt() == null || req.endAt() == null) {
                throw BizException.validation("startAt/endAt 必填");
            }
            OffsetDateTime startAt = OffsetDateTime.parse(req.startAt());
            OffsetDateTime endAt = OffsetDateTime.parse(req.endAt());
            if (!endAt.isAfter(startAt)) {
                throw BizException.validation("结束时间必须晚于开始时间");
            }
            // 先对当前版本日历行加悲观写锁再做校验：并发写同一日历在锁上串行，
            // 消除"先查后判"的 TOCTOU 重叠（毕设规模不引入 btree_gist 排除约束）。
            WorkCalendar current = lockActiveCalendar(calendarId);
            List<CalendarInterval> intervals =
                    calendarIntervalRepository.findByCalendarIdOrderByStartAt(calendarId);
            if (!"WORK".equals(req.intervalType())) {
                for (CalendarInterval existing : intervals) {
                    if ("WORK".equals(existing.getIntervalType())) {
                        continue;
                    }
                    if (startAt.isBefore(existing.getEndAt()) && endAt.isAfter(existing.getStartAt())) {
                        throw BizException.validation("不可用区间与已有区间 [" + existing.getStartAt() + " ~ "
                                + existing.getEndAt() + "] 重叠");
                    }
                }
            }
            if ("REPAIR".equals(req.intervalType())) {
                assertRepairNotCoveringCompleted(calendarId, startAt, endAt);
            }
            String changeNote = ("WORK".equals(req.intervalType()) ? "新增班次区间 WORK [" : "新增不可用区间 "
                    + req.intervalType() + " [") + startAt + " ~ " + endAt + "]";
            WorkCalendar next = createNextVersion(current, intervals, changeNote);

            CalendarInterval interval = new CalendarInterval();
            interval.setId(UUID.randomUUID().toString());
            interval.setCalendarId(next.getId());
            interval.setStartAt(startAt);
            interval.setEndAt(endAt);
            interval.setIntervalType(req.intervalType());
            interval.setNote(req.note());
            calendarIntervalRepository.save(interval);
            return new CalendarIntervalCreatedResponse(interval.getId(), interval.getCalendarId(),
                    interval.getIntervalType(), interval.getStartAt(), interval.getEndAt(),
                    interval.getNote(), next.getCalendarVersion());
        }, CalendarIntervalCreatedResponse.class);
    }

    @Transactional
    public CalendarIntervalDeletedResponse deleteCalendarInterval(String idempotencyKey, String calendarId,
                                                                  String intervalId) {
        return idempotencyService.execute(idempotencyKey,
                Map.of("calendarId", calendarId, "intervalId", intervalId), () -> {
            WorkCalendar current = lockActiveCalendar(calendarId);
            List<CalendarInterval> intervals =
                    calendarIntervalRepository.findByCalendarIdOrderByStartAt(calendarId);
            CalendarInterval target = null;
            for (CalendarInterval ci : intervals) {
                if (ci.getId().equals(intervalId)) {
                    target = ci;
                }
            }
            if (target == null) {
                throw BizException.notFound("区间不存在于该日历当前版本: " + intervalId);
            }
            List<CalendarInterval> kept = new ArrayList<>(intervals);
            kept.remove(target);
            String changeNote = "删除区间 " + target.getIntervalType()
                    + " [" + target.getStartAt() + " ~ " + target.getEndAt() + "]";
            WorkCalendar next = createNextVersion(current, kept, changeNote);
            return new CalendarIntervalDeletedResponse(next.getId(), next.getCalendarCode(),
                    next.getCalendarVersion(), intervalId, changeNote);
        }, CalendarIntervalDeletedResponse.class);
    }

    private WorkCalendar lockActiveCalendar(String calendarId) {
        WorkCalendar current = workCalendarRepository.findByIdForUpdate(calendarId)
                .orElseThrow(() -> BizException.notFound("日历不存在: " + calendarId));
        if (!"ACTIVE".equals(current.getStatus())) {
            throw BizException.stateConflict("日历 " + calendarId + " 是历史版本（v" + current.getCalendarVersion()
                    + "），不可变更，请对当前生效版本操作");
        }
        return current;
    }

    /**
     * 日历变更 = 生成新版本：把给定区间集合复制到新版本行（新区间 id），归档旧版本，
     * 并把绑定旧版本的设备重指向新版本。历史版本行与其区间保持不改写；
     * 已生成的任务快照内联了当时的可用区间，天然不受版本演进影响。
     */
    private WorkCalendar createNextVersion(WorkCalendar current, List<CalendarInterval> nextIntervals,
                                           String changeNote) {
        WorkCalendar next = new WorkCalendar();
        next.setId(UUID.randomUUID().toString());
        next.setCalendarCode(current.getCalendarCode());
        next.setCalendarVersion(current.getCalendarVersion() + 1);
        next.setStatus("ACTIVE");
        next.setChangeNote(changeNote);
        workCalendarRepository.save(next);
        for (CalendarInterval ci : nextIntervals) {
            CalendarInterval copy = new CalendarInterval();
            copy.setId(UUID.randomUUID().toString());
            copy.setCalendarId(next.getId());
            copy.setStartAt(ci.getStartAt());
            copy.setEndAt(ci.getEndAt());
            copy.setIntervalType(ci.getIntervalType());
            copy.setNote(ci.getNote());
            calendarIntervalRepository.save(copy);
        }
        for (Machine machine : machineRepository.findByCalendarId(current.getId())) {
            machine.setCalendarId(next.getId());
            machineRepository.save(machine);
        }
        current.setStatus("ARCHIVED");
        workCalendarRepository.save(current);
        auditService.record("CALENDAR_VERSION", "calendar", current.getCalendarCode(),
                changeNote + "；v" + current.getCalendarVersion() + " -> v" + next.getCalendarVersion());
        return next;
    }

    /** 维修区间不得覆盖已完成的执行记录：回溯绑定本日历的设备在任意计划版本上的执行历史。 */
    private void assertRepairNotCoveringCompleted(String calendarId, OffsetDateTime startAt,
                                                  OffsetDateTime endAt) {
        List<String> machineIds = machineRepository.findByCalendarId(calendarId).stream()
                .map(Machine::getId).toList();
        if (machineIds.isEmpty()) {
            return;
        }
        List<String> operationIds = scheduleOperationRepository.findByMachineIdIn(machineIds).stream()
                .map(ScheduleOperation::getOperationId).toList();
        if (operationIds.isEmpty()) {
            return;
        }
        for (ExecutionRecord r : executionRecordRepository.findByOperationIdIn(operationIds)) {
            if (!"COMPLETED".equals(r.getStatus()) || r.getActualStartAt() == null
                    || r.getActualEndAt() == null) {
                continue;
            }
            if (startAt.isBefore(r.getActualEndAt()) && endAt.isAfter(r.getActualStartAt())) {
                throw BizException.validation("维修区间覆盖已完成的执行记录（工序 " + r.getOperationId() + "，"
                        + r.getActualStartAt() + " ~ " + r.getActualEndAt() + "），历史不可改写");
            }
        }
    }

    private CalendarIntervalResponse toResponse(CalendarInterval ci) {
        return new CalendarIntervalResponse(ci.getId(), ci.getCalendarId(), ci.getIntervalType(),
                ci.getStartAt(), ci.getEndAt(), ci.getNote());
    }
}
