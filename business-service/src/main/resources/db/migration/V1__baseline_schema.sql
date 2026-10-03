-- Flyway V1 baseline schema for FJSP business service.
-- Generated from the Hibernate-managed development database (PostgreSQL 16, pg_dump --schema-only --no-owner --no-privileges).
-- 17 business tables; applied automatically on empty databases, existing databases are baselined at version 1.


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE public.audit_log (
    id character varying(255) NOT NULL,
    action character varying(255) NOT NULL,
    created_at timestamp(6) with time zone NOT NULL,
    detail character varying(4000),
    object_id character varying(255) NOT NULL,
    object_type character varying(255) NOT NULL,
    request_id character varying(255),
    operator character varying(255),
    session_id character varying(255),
    source character varying(255)
);

CREATE TABLE public.calendar_interval (
    id character varying(255) NOT NULL,
    calendar_id character varying(255) NOT NULL,
    end_at timestamp(6) with time zone NOT NULL,
    interval_type character varying(255) NOT NULL,
    start_at timestamp(6) with time zone NOT NULL,
    note character varying(500)
);

CREATE TABLE public.event (
    id character varying(255) NOT NULL,
    event_code character varying(255) NOT NULL,
    event_type character varying(255) NOT NULL,
    fingerprint character varying(255),
    machine_id character varying(255),
    note character varying(2000),
    occurred_at timestamp(6) with time zone NOT NULL,
    order_id character varying(255),
    recorded_at timestamp(6) with time zone NOT NULL,
    repair_duration_minutes integer,
    repair_end_at timestamp(6) with time zone,
    revision_of character varying(255),
    source character varying(255),
    status character varying(255) NOT NULL,
    sub_type character varying(255)
);

CREATE TABLE public.event_impact (
    id character varying(255) NOT NULL,
    event_id character varying(255) NOT NULL,
    impact_reason character varying(1000),
    impact_type character varying(255) NOT NULL,
    lock_type character varying(255) NOT NULL,
    operation_id character varying(255) NOT NULL,
    reason_code character varying(255)
);

CREATE TABLE public.execution_record (
    id character varying(255) NOT NULL,
    actual_end_at timestamp(6) with time zone,
    actual_start_at timestamp(6) with time zone,
    created_at timestamp(6) with time zone NOT NULL,
    operation_id character varying(255) NOT NULL,
    plan_version_id character varying(255) NOT NULL,
    remark character varying(1000),
    status character varying(255) NOT NULL,
    version bigint
);

CREATE TABLE public.idempotency_record (
    id character varying(255) NOT NULL,
    created_at timestamp(6) with time zone NOT NULL,
    expires_at timestamp(6) with time zone NOT NULL,
    idempotency_key character varying(255) NOT NULL,
    request_hash character varying(255) NOT NULL,
    response_json jsonb NOT NULL
);

CREATE TABLE public.input_snapshot (
    id character varying(255) NOT NULL,
    created_at timestamp(6) with time zone NOT NULL,
    snapshot_hash character varying(255) NOT NULL,
    snapshot_json jsonb NOT NULL,
    task_id character varying(255) NOT NULL
);

CREATE TABLE public.machine (
    id character varying(255) NOT NULL,
    calendar_id character varying(255),
    machine_code character varying(255) NOT NULL,
    product_families jsonb,
    status character varying(255) NOT NULL,
    work_center_id character varying(255),
    machine_name character varying(255),
    remark character varying(500)
);

CREATE TABLE public.operation_candidate (
    id character varying(255) NOT NULL,
    machine_id character varying(255) NOT NULL,
    operation_id character varying(255) NOT NULL,
    process_minutes integer NOT NULL,
    setup_minutes integer NOT NULL
);

CREATE TABLE public.order_operation (
    id character varying(255) NOT NULL,
    candidates jsonb,
    order_id character varying(255) NOT NULL,
    sequence_no integer NOT NULL,
    status character varying(255) NOT NULL
);

CREATE TABLE public.plan_version (
    id character varying(255) NOT NULL,
    candidate_group_id character varying(255),
    candidate_type character varying(255) NOT NULL,
    created_at timestamp(6) with time zone NOT NULL,
    kpi jsonb,
    parent_id character varying(255),
    published_at timestamp(6) with time zone,
    review_comment character varying(2000),
    status character varying(255) NOT NULL,
    task_id character varying(255),
    version bigint,
    version_code character varying(255) NOT NULL,
    published_by character varying(255),
    reviewed_at timestamp(6) with time zone,
    reviewed_by character varying(255)
);

CREATE TABLE public.process_operation (
    id character varying(255) NOT NULL,
    default_candidates jsonb,
    operation_code character varying(255) NOT NULL,
    sequence_no integer NOT NULL,
    template_id character varying(255) NOT NULL
);

CREATE TABLE public.process_template (
    id character varying(255) NOT NULL,
    product_family character varying(255) NOT NULL,
    status character varying(255) NOT NULL,
    template_code character varying(255) NOT NULL,
    template_version integer NOT NULL
);

CREATE TABLE public.production_order (
    id character varying(255) NOT NULL,
    arrival_at timestamp(6) with time zone NOT NULL,
    created_at timestamp(6) with time zone NOT NULL,
    due_at timestamp(6) with time zone NOT NULL,
    order_code character varying(255) NOT NULL,
    priority integer NOT NULL,
    product_family character varying(255) NOT NULL,
    quantity integer NOT NULL,
    status character varying(255) NOT NULL,
    template_id character varying(255)
);

CREATE TABLE public.schedule_operation (
    id character varying(255) NOT NULL,
    affected boolean NOT NULL,
    changeover_minutes integer NOT NULL,
    end_at timestamp(6) with time zone NOT NULL,
    frozen boolean NOT NULL,
    machine_id character varying(255) NOT NULL,
    operation_id character varying(255) NOT NULL,
    plan_version_id character varying(255) NOT NULL,
    process_start_at timestamp(6) with time zone,
    reason_code character varying(255),
    setup_start_at timestamp(6) with time zone,
    start_at timestamp(6) with time zone NOT NULL
);

CREATE TABLE public.schedule_task (
    id character varying(255) NOT NULL,
    algorithm_version character varying(255),
    candidate_group_id character varying(255),
    conflicts jsonb,
    created_at timestamp(6) with time zone NOT NULL,
    elapsed_ms bigint,
    error_message character varying(2000),
    event_id character varying(255),
    feasible_solution boolean,
    fingerprint character varying(255),
    finished_at timestamp(6) with time zone,
    kpi jsonb,
    mode character varying(255) NOT NULL,
    old_plan_version_id character varying(255),
    plan_version_id character varying(255),
    progress integer NOT NULL,
    random_seed integer,
    result_status character varying(255),
    snapshot_hash character varying(255),
    started_at timestamp(6) with time zone,
    status character varying(255) NOT NULL,
    task_code character varying(255) NOT NULL
);

CREATE TABLE public.work_calendar (
    id character varying(255) NOT NULL,
    calendar_code character varying(255) NOT NULL,
    calendar_version integer NOT NULL,
    status character varying(255) NOT NULL
);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.calendar_interval
    ADD CONSTRAINT calendar_interval_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.event_impact
    ADD CONSTRAINT event_impact_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.event
    ADD CONSTRAINT event_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.execution_record
    ADD CONSTRAINT execution_record_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.idempotency_record
    ADD CONSTRAINT idempotency_record_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.input_snapshot
    ADD CONSTRAINT input_snapshot_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.machine
    ADD CONSTRAINT machine_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.operation_candidate
    ADD CONSTRAINT operation_candidate_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.order_operation
    ADD CONSTRAINT order_operation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.plan_version
    ADD CONSTRAINT plan_version_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.process_operation
    ADD CONSTRAINT process_operation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.process_template
    ADD CONSTRAINT process_template_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.production_order
    ADD CONSTRAINT production_order_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.schedule_operation
    ADD CONSTRAINT schedule_operation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.schedule_task
    ADD CONSTRAINT schedule_task_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.machine
    ADD CONSTRAINT uk2jmw8tvv9qc61u1yf2ecuhxx8 UNIQUE (machine_code);

ALTER TABLE ONLY public.process_operation
    ADD CONSTRAINT uk3ebc3n01ah8m0833q2c7l0be5 UNIQUE (template_id, sequence_no);

ALTER TABLE ONLY public.event_impact
    ADD CONSTRAINT uk40qb11i0eodfpk6g66eyu1yr1 UNIQUE (event_id, operation_id);

ALTER TABLE ONLY public.schedule_operation
    ADD CONSTRAINT uk5hysoyn8dq9kdyo3ip4aqfbyd UNIQUE (plan_version_id, operation_id);

ALTER TABLE ONLY public.operation_candidate
    ADD CONSTRAINT uk6mcvoipfdmq0x9thaa5uhi84n UNIQUE (operation_id, machine_id);

ALTER TABLE ONLY public.work_calendar
    ADD CONSTRAINT uk7gw7mhp5l3u48lid47h8vne8h UNIQUE (calendar_code, calendar_version);

ALTER TABLE ONLY public.process_template
    ADD CONSTRAINT uk7vwqjtc3l5631hb9i37hwefq5 UNIQUE (template_code, template_version);

ALTER TABLE ONLY public.input_snapshot
    ADD CONSTRAINT ukbdgt4bwn06qiy49bulmp5lhl8 UNIQUE (task_id);

ALTER TABLE ONLY public.schedule_task
    ADD CONSTRAINT ukdgqypi92n060l9e4ynn12gy15 UNIQUE (task_code);

ALTER TABLE ONLY public.event
    ADD CONSTRAINT ukhvcybi88hxclsja1y8y7yt4hs UNIQUE (event_code);

ALTER TABLE ONLY public.idempotency_record
    ADD CONSTRAINT ukixtia2gi4nwc73k5jwss4vflk UNIQUE (idempotency_key);

ALTER TABLE ONLY public.schedule_task
    ADD CONSTRAINT ukjx7gl92qxv8vnlbafev82l6rl UNIQUE (fingerprint);

ALTER TABLE ONLY public.production_order
    ADD CONSTRAINT uklln450ru85mcrcggnkocevsbq UNIQUE (order_code);

ALTER TABLE ONLY public.event
    ADD CONSTRAINT ukmpaf5spc7vrwwrhh0hd5w0jk1 UNIQUE (fingerprint);

ALTER TABLE ONLY public.plan_version
    ADD CONSTRAINT ukroybwx66kkht6410xc6wkvo8e UNIQUE (version_code);

ALTER TABLE ONLY public.order_operation
    ADD CONSTRAINT ukten2ak8t2m1ldxo47880fmdeg UNIQUE (order_id, sequence_no);

ALTER TABLE ONLY public.work_calendar
    ADD CONSTRAINT work_calendar_pkey PRIMARY KEY (id);

