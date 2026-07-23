begin;


/* ========================================
   小心脏模型唤醒策略 v0.1

   interval_min_minutes / interval_max_minutes
   继续表示“程序巡检间隔”。

   本迁移新增的字段只控制普通自动心跳是否真正调用模型。
   手动唤醒与自由活动仍使用各自的明确授权和预算。
======================================== */

alter table public.heartbeat_preferences
  add column if not exists natural_wake_enabled boolean
    not null default true,

  add column if not exists natural_wake_min_per_day integer
    not null default 3,

  add column if not exists natural_wake_max_per_day integer
    not null default 6,

  add column if not exists min_model_wake_interval_minutes integer
    not null default 120,

  add column if not exists daily_model_call_limit integer
    not null default 6,

  add column if not exists daily_cost_limit_usd numeric(12, 6)
    not null default 0.20;


/* ----------------------------------------
   重复执行迁移时也能安全补齐约束
---------------------------------------- */

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname =
      'heartbeat_preferences_natural_wake_min_check'
  ) then
    alter table public.heartbeat_preferences
      add constraint
        heartbeat_preferences_natural_wake_min_check
      check (
        natural_wake_min_per_day between 0 and 24
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname =
      'heartbeat_preferences_natural_wake_max_check'
  ) then
    alter table public.heartbeat_preferences
      add constraint
        heartbeat_preferences_natural_wake_max_check
      check (
        natural_wake_max_per_day between 0 and 24
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname =
      'heartbeat_preferences_natural_wake_range_check'
  ) then
    alter table public.heartbeat_preferences
      add constraint
        heartbeat_preferences_natural_wake_range_check
      check (
        natural_wake_min_per_day <=
          natural_wake_max_per_day
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname =
      'heartbeat_preferences_model_interval_check'
  ) then
    alter table public.heartbeat_preferences
      add constraint
        heartbeat_preferences_model_interval_check
      check (
        min_model_wake_interval_minutes
          between 15 and 1440
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname =
      'heartbeat_preferences_daily_call_limit_check'
  ) then
    alter table public.heartbeat_preferences
      add constraint
        heartbeat_preferences_daily_call_limit_check
      check (
        daily_model_call_limit between 0 and 100
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname =
      'heartbeat_preferences_daily_cost_limit_check'
  ) then
    alter table public.heartbeat_preferences
      add constraint
        heartbeat_preferences_daily_cost_limit_check
      check (
        daily_cost_limit_usd between 0 and 100
      );
  end if;
end;
$$;


comment on column
  public.heartbeat_preferences.interval_min_minutes
is '程序巡检最短间隔；巡检本身通常不调用模型';

comment on column
  public.heartbeat_preferences.interval_max_minutes
is '程序巡检最长间隔；巡检本身通常不调用模型';

comment on column
  public.heartbeat_preferences.natural_wake_enabled
is '是否允许普通自动心跳产生自然醒来机会';

comment on column
  public.heartbeat_preferences.natural_wake_min_per_day
is '每天自然醒来目标范围下限';

comment on column
  public.heartbeat_preferences.natural_wake_max_per_day
is '每天自然醒来目标范围上限';

comment on column
  public.heartbeat_preferences.min_model_wake_interval_minutes
is '普通自动心跳两次真实模型调用之间的最短间隔';

comment on column
  public.heartbeat_preferences.daily_model_call_limit
is '普通自动心跳每日真实模型调用上限；0 表示当天不自动调用模型';

comment on column
  public.heartbeat_preferences.daily_cost_limit_usd
is '普通自动心跳每日预估费用上限；0 表示不启用费用上限';


commit;
