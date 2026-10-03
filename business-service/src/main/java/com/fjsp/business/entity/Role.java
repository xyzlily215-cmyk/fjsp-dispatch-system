package com.fjsp.business.entity;

/**
 * 业务角色：DISPATCHER 调度员 / REVIEWER 审核员 / PRODUCTION_MANAGER 生产主管 / ADMIN 管理员。
 * SecurityContext 中以 ROLE_<name> 形式作为 authority。
 */
public enum Role {
    DISPATCHER,
    REVIEWER,
    PRODUCTION_MANAGER,
    ADMIN
}
