/*
  404 全屋调度器 v0.1 · 只读验收

  预期：
  - 三张调度表存在并启用 RLS
  - 自动心跳发布总闸默认关闭
  - 心跳输入 / 输出预算默认为 8000 / 24000
  - 自由活动进度与通行证使用同屋主复合外键

  本文件只读取数据库，不修改数据。
*/

with expected_tables(table_name) as (
  values
    ('home_runtime_settings'),
    ('home_interaction_sessions'),
    ('free_activity_progress')
),

table_checks as (
  select
    'table'::text as category,
    expected.table_name as item,
    (
      relation.oid is not null and
      relation.relrowsecurity
    ) as ok,
    case
      when relation.oid is null then
        '表不存在'
      when not relation.relrowsecurity then
        '表存在，但 RLS 未启用'
      else
        '表存在，RLS 已启用'
    end as detail
  from expected_tables as expected
  left join pg_class as relation
    on relation.oid =
      to_regclass(
        'public.' || expected.table_name
      )
),

policy_checks as (
  select
    'policy'::text as category,
    expected.table_name || ':' || expected.command as item,
    actual.policyname is not null as ok,
    coalesce(actual.policyname, '策略不存在') as detail
  from (
    select table_name, command
    from expected_tables
    cross join (
      values ('SELECT'), ('INSERT'), ('UPDATE')
    ) as commands(command)
  ) as expected
  left join pg_policies as actual
    on actual.schemaname = 'public'
    and actual.tablename = expected.table_name
    and actual.cmd = expected.command
),

constraint_checks as (
  select
    'constraint'::text as category,
    'free_activity_progress_pass_owner_fk'::text as item,
    exists (
      select 1
      from pg_constraint
      where conname =
        'free_activity_progress_pass_owner_fk'
    ) as ok,
    '自由活动进度与通行证必须属于同一屋主'::text as detail
),

index_checks as (
  select
    'index'::text as category,
    expected.index_name as item,
    actual.indexname is not null as ok,
    case
      when actual.indexname is null then
        '索引不存在'
      else
        '索引存在'
    end as detail
  from (
    values
      ('home_interaction_sessions_owner_channel_active_uidx'),
      ('home_interaction_sessions_idempotency_uidx'),
      ('home_interaction_sessions_owner_expiry_idx'),
      ('activity_passes_id_owner_uidx'),
      ('free_activity_progress_owner_state_idx')
  ) as expected(index_name)
  left join pg_indexes as actual
    on actual.schemaname = 'public'
    and actual.indexname = expected.index_name
),

default_checks as (
  select
    'default'::text as category,
    check_item as item,
    ok,
    detail
  from (
    select
      'automatic_heartbeat_release_enabled'::text as check_item,
      column_default = 'false'::text as ok,
      coalesce(column_default, '无默认值') as detail
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'home_runtime_settings'
      and column_name =
        'automatic_heartbeat_release_enabled'

    union all

    select
      'heartbeat_input_token_budget',
      column_default = '8000',
      coalesce(column_default, '无默认值')
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'home_runtime_settings'
      and column_name =
        'heartbeat_input_token_budget'

    union all

    select
      'heartbeat_max_output_tokens',
      column_default = '24000',
      coalesce(column_default, '无默认值')
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'home_runtime_settings'
      and column_name =
        'heartbeat_max_output_tokens'
  ) as defaults
),

all_checks as (
  select * from table_checks
  union all
  select * from policy_checks
  union all
  select * from constraint_checks
  union all
  select * from index_checks
  union all
  select * from default_checks
)

select
  category,
  item,
  ok,
  detail
from all_checks
order by
  ok asc,
  category,
  item;
