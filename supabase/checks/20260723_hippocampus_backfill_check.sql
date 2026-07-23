/*
  白狐狸海马体 v0.1 · 回填只读验收

  预期：
  - 书房与全屋事件已搬入 hippocampus_memories
  - 幂等键没有重复
  - 消息与会话的同屋主外键已经安装
  - 会话所属复合唯一索引已经安装

  本文件只读取数据库，不修改任何数据。
*/

with source_counts as (
  select
    source_type,
    count(*)::bigint as item_count
  from public.hippocampus_memories
  where source_type in ('study_entry', 'home_event')
  group by source_type
),

duplicate_keys as (
  select count(*)::bigint as duplicate_group_count
  from (
    select owner_user_id, idempotency_key
    from public.hippocampus_memories
    where idempotency_key is not null
    group by owner_user_id, idempotency_key
    having count(*) > 1
  ) as duplicates
),

constraint_check as (
  select exists (
    select 1
    from pg_constraint
    where conname =
      'hippocampus_messages_conversation_owner_fk'
  ) as installed
),

index_check as (
  select exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname =
        'hippocampus_conversations_id_owner_uidx'
  ) as installed
)

select
  'backfill_count'::text as category,
  coalesce(source_type, 'total') as item,
  item_count::text as value,
  true as ok
from source_counts

union all

select
  'backfill_count',
  'total',
  count(*)::text,
  true
from public.hippocampus_memories
where source_type in ('study_entry', 'home_event')

union all

select
  'integrity',
  'duplicate_idempotency_groups',
  duplicate_group_count::text,
  duplicate_group_count = 0
from duplicate_keys

union all

select
  'integrity',
  'message_conversation_owner_fk',
  installed::text,
  installed
from constraint_check

union all

select
  'integrity',
  'conversation_owner_unique_index',
  installed::text,
  installed
from index_check

order by category, item;
