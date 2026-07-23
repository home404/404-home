begin;


/* ========================================
   白狐狸海马体 v0.1 · 所属完整性

   消息引用的会话必须属于同一位屋主。
   不能只依赖 RLS 或 UUID 难猜来保证这一点。
======================================== */

create unique index if not exists
  hippocampus_conversations_id_owner_uidx
  on public.hippocampus_conversations (
    id,
    owner_user_id
  );


do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname =
      'hippocampus_messages_conversation_owner_fk'
  ) then
    alter table public.hippocampus_messages
      drop constraint if exists
        hippocampus_messages_conversation_id_fkey;

    alter table public.hippocampus_messages
      add constraint
        hippocampus_messages_conversation_owner_fk
      foreign key (
        conversation_id,
        owner_user_id
      )
      references public.hippocampus_conversations (
        id,
        owner_user_id
      )
      on delete cascade;
  end if;
end;
$$;


/* ========================================
   白狐狸海马体 v0.1 · 旧资料回填

   - 书房正文与摘要搬入可追溯记忆卡
   - 全屋事件搬入事件摘要记忆
   - 使用稳定幂等键，可安全重复执行
   - 不删除、不覆盖原有书房与事件表
======================================== */


insert into public.hippocampus_memories (
  owner_user_id,
  memory_type,
  title,
  content,
  summary,
  tags,
  importance,
  source_type,
  source_id,
  source_ref,
  occurred_at,
  idempotency_key,
  metadata
)
select
  entry.owner_user_id,

  case entry.entry_type
    when 'favorite' then 'preference'
    when 'diary' then 'event_summary'
    when 'message' then 'relationship'
    else 'event_summary'
  end,

  entry.title,

  coalesce(
    nullif(entry.body, ''),
    nullif(entry.summary, ''),
    entry.title
  ),

  nullif(entry.summary, ''),

  array(
    select distinct clean_tag
    from unnest(
      coalesce(entry.tags, '{}'::text[]) ||
      array[
        '书房',
        entry.entry_type
      ]
    ) as clean_tag
    where clean_tag is not null
      and btrim(clean_tag) <> ''
  ),

  case entry.entry_type
    when 'favorite' then 80
    when 'diary' then 70
    when 'message' then 65
    else 50
  end,

  'study_entry',
  entry.id::text,

  jsonb_build_object(
    'table', 'study_entries',
    'entryType', entry.entry_type,
    'createdBy', entry.created_by,
    'source', entry.source,
    'visibility', entry.visibility,
    'sourceRef', coalesce(
      entry.source_ref,
      '{}'::jsonb
    )
  ),

  entry.created_at,
  'study-entry-' || entry.id::text,

  jsonb_build_object(
    'backfilledBy',
      '20260723_03_hippocampus_backfill',
    'originalUpdatedAt',
      entry.updated_at
  )

from public.study_entries as entry

on conflict (
  owner_user_id,
  idempotency_key
)
where idempotency_key is not null
  do nothing;


insert into public.hippocampus_memories (
  owner_user_id,
  memory_type,
  title,
  content,
  summary,
  tags,
  importance,
  source_type,
  source_id,
  source_ref,
  occurred_at,
  idempotency_key,
  metadata
)
select
  event.owner_user_id,
  'event_summary',
  event.title,

  concat_ws(
    '｜',
    event.title,
    nullif(event.detail, '')
  ),

  nullif(event.detail, ''),

  array(
    select distinct clean_tag
    from unnest(
      array[
        '全屋事件',
        event.event_type,
        event.room
      ]
    ) as clean_tag
    where clean_tag is not null
      and btrim(clean_tag) <> ''
  ),

  case
    when event.event_type in (
      'free_activity_started',
      'free_activity_completed'
    ) then 65
    when event.is_user_visible then 55
    else 35
  end,

  'home_event',
  event.id::text,

  jsonb_build_object(
    'table', 'home_events',
    'actor', event.actor,
    'source', event.source,
    'eventType', event.event_type,
    'room', event.room,
    'visibility', event.visibility,
    'isUserVisible', event.is_user_visible,
    'activityPassId',
      event.activity_pass_id,
    'activityRunId',
      event.activity_run_id,
    'heartbeatRunId',
      event.heartbeat_run_id,
    'studyEntryId',
      event.study_entry_id
  ),

  event.occurred_at,
  'home-event-' || event.id::text,

  jsonb_build_object(
    'backfilledBy',
      '20260723_03_hippocampus_backfill',
    'originalMetadata',
      coalesce(event.metadata, '{}'::jsonb)
  )

from public.home_events as event

on conflict (
  owner_user_id,
  idempotency_key
)
where idempotency_key is not null
  do nothing;


commit;
