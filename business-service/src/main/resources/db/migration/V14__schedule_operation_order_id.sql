-- V14: schedule_operation 冗余 order_id 列——看板按订单归组无需依赖 operationId 命名约定字符串截取。
-- 新计划由 ScheduleResultAssembler 经 OrderOperation 批量解析订单归属；
-- 存量计划按工序主键关联回填，不依赖编号格式，不覆盖已有归属。
-- 找不到源工序的历史孤立记录保留 NULL，不猜测其所属订单。
ALTER TABLE public.schedule_operation
    ADD COLUMN IF NOT EXISTS order_id character varying(255);

UPDATE public.schedule_operation AS scheduled
SET order_id = operation.order_id
FROM public.order_operation AS operation
WHERE scheduled.operation_id = operation.id
  AND scheduled.order_id IS NULL;
