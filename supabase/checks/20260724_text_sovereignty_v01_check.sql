/*
  404 文字主权 v0.1 只读验收

  运行方式：Supabase SQL Editor 执行。
  所有结果都应为 true / 存在，且不会修改数据。
*/

select
  to_regclass('public.text_item_states') is not null
    as text_item_states_exists,
  to_regclass('public.bedroom_message_reads') is not null
    as bedroom_message_reads_exists;

select
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'text_item_states'
      and column_name = 'archived_at'
  ) as archive_column_exists,
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'bedroom_message_reads'
      and column_name = 'read_at'
  ) as read_column_exists;

select
  exists (
    select 1
    from pg_proc
    where proname =
      'mirror_mcp_study_message_to_bedroom'
  ) as bedroom_message_mirror_function_exists;

select
  exists (
    select 1
    from pg_trigger
    where tgname = 'study_message_to_bedroom'
      and not tgisinternal
  ) as bedroom_message_mirror_trigger_exists;

select
  relname,
  relrowsecurity
from pg_class
where oid in (
  'public.text_item_states'::regclass,
  'public.bedroom_message_reads'::regclass
)
order by relname;

select
  policyname,
  tablename,
  cmd
from pg_policies
where schemaname = 'public'
  and tablename in (
    'text_item_states',
    'bedroom_message_reads'
  )
order by tablename, policyname;
