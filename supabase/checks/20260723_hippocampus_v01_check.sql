/*
  白狐狸海马体 v0.1 · 只读验收

  预期：
  - 四张表全部存在
  - 四张表全部启用 RLS
  - 对 authenticated 的权限符合最小权限设计
  - 10 条屋主隔离策略存在
  - 9 个核心索引存在

  本文件只读取 PostgreSQL 系统目录，不修改任何数据。
*/

with expected_tables(table_name) as (
  values
    ('hippocampus_conversations'),
    ('hippocampus_messages'),
    ('hippocampus_memories'),
    ('hippocampus_retrievals')
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

expected_privileges(
  table_name,
  privilege_name
) as (
  values
    ('hippocampus_conversations', 'SELECT'),
    ('hippocampus_conversations', 'INSERT'),
    ('hippocampus_conversations', 'UPDATE'),
    ('hippocampus_messages', 'SELECT'),
    ('hippocampus_messages', 'INSERT'),
    ('hippocampus_memories', 'SELECT'),
    ('hippocampus_memories', 'INSERT'),
    ('hippocampus_memories', 'UPDATE'),
    ('hippocampus_retrievals', 'SELECT'),
    ('hippocampus_retrievals', 'INSERT')
),

privilege_checks as (
  select
    'privilege'::text as category,
    expected.table_name || ':' ||
      expected.privilege_name as item,
    has_table_privilege(
      'authenticated',
      'public.' || expected.table_name,
      expected.privilege_name
    ) as ok,
    case
      when has_table_privilege(
        'authenticated',
        'public.' || expected.table_name,
        expected.privilege_name
      ) then
        'authenticated 已获得预期权限'
      else
        'authenticated 缺少预期权限'
    end as detail
  from expected_privileges as expected
),

expected_policies(
  table_name,
  policy_name,
  command
) as (
  values
    (
      'hippocampus_conversations',
      'hippocampus_conversations_select_own',
      'SELECT'
    ),
    (
      'hippocampus_conversations',
      'hippocampus_conversations_insert_own',
      'INSERT'
    ),
    (
      'hippocampus_conversations',
      'hippocampus_conversations_update_own',
      'UPDATE'
    ),
    (
      'hippocampus_messages',
      'hippocampus_messages_select_own',
      'SELECT'
    ),
    (
      'hippocampus_messages',
      'hippocampus_messages_insert_own',
      'INSERT'
    ),
    (
      'hippocampus_memories',
      'hippocampus_memories_select_own',
      'SELECT'
    ),
    (
      'hippocampus_memories',
      'hippocampus_memories_insert_own',
      'INSERT'
    ),
    (
      'hippocampus_memories',
      'hippocampus_memories_update_own',
      'UPDATE'
    ),
    (
      'hippocampus_retrievals',
      'hippocampus_retrievals_select_own',
      'SELECT'
    ),
    (
      'hippocampus_retrievals',
      'hippocampus_retrievals_insert_own',
      'INSERT'
    )
),

policy_checks as (
  select
    'policy'::text as category,
    expected.policy_name as item,
    actual.policyname is not null as ok,
    case
      when actual.policyname is null then
        '策略不存在'
      else
        '策略存在：' || actual.cmd
    end as detail
  from expected_policies as expected
  left join pg_policies as actual
    on actual.schemaname = 'public'
    and actual.tablename =
      expected.table_name
    and actual.policyname =
      expected.policy_name
    and actual.cmd = expected.command
),

expected_indexes(index_name) as (
  values
    (
      'hippocampus_conversations_owner_client_key_uidx'
    ),
    (
      'hippocampus_conversations_owner_active_idx'
    ),
    (
      'hippocampus_messages_idempotency_uidx'
    ),
    (
      'hippocampus_messages_conversation_time_idx'
    ),
    (
      'hippocampus_messages_owner_recent_idx'
    ),
    (
      'hippocampus_memories_idempotency_uidx'
    ),
    (
      'hippocampus_memories_owner_active_idx'
    ),
    (
      'hippocampus_memories_tags_gin_idx'
    ),
    (
      'hippocampus_retrievals_owner_created_idx'
    )
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
  from expected_indexes as expected
  left join pg_indexes as actual
    on actual.schemaname = 'public'
    and actual.indexname =
      expected.index_name
),

all_checks as (
  select * from table_checks
  union all
  select * from privilege_checks
  union all
  select * from policy_checks
  union all
  select * from index_checks
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
