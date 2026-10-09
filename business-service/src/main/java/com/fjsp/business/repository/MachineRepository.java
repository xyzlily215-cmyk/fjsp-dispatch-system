package com.fjsp.business.repository;

import java.util.List;

import com.fjsp.business.entity.Machine;
import org.springframework.data.jpa.repository.JpaRepository;

public interface MachineRepository extends JpaRepository<Machine, String> {
    boolean existsByMachineCode(String machineCode);

    /** 绑定到指定日历版本的设备：日历版本化时批量重指向新版本。 */
    List<Machine> findByCalendarId(String calendarId);
}
