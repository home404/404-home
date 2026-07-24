begin;

/*
  404 文字主权 v0.1

  1. 所有面向谢诗的文字都能在手机端总账中找到；
  2. 归档状态独立保存，不污染原文表；
  3. 官端通过现有书房 message 通行证写下的短消息，自动送进卧室；
  4. 卧室已读状态单独保存，不修改聊天原文。
*/

create table if not exists public.text_item_states (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null,
  source_id uuid not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, source_type, source_id)
);

create index if not exists text_item_states_owner_archive_idx
  on public.text_item_states (owner_user_id, archived_at desc);

drop trigger if exists text_item_states_set_updated_at
  on public.text_item_states;
create trigger text_item_states_set_updated_at
before update on public.text_item_states
for each row execute function public.set_updated_at();

alter table public.text_item_states enable row level security;
revoke all on table public.text_item_states from anon, authenticated;
grant select on table public.text_item_states to authenticated;

drop policy if exists text_item_states_select_own
  on public.text_item_states;
create policy text_item_states_select_own
on public.text_item_states
for select to authenticated
using (owner_user_id = (select auth.uid()));

create table if not exists public.bedroom_message_reads (
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null references public.hippocampus_messages(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (owner_user_id, message_id)
);

create index if not exists bedroom_message_reads_owner_time_idx
  on public.bedroom_message_reads (owner_user_id, read_at desc);

alter table public.bedroom_message_reads enable row level security;
revoke all on table public.bedroom_message_reads from anon, authenticated;
grant select on table public.bedroom_message_reads to authenticated;

drop policy if exists bedroom_message_reads_select_own
  on public.bedroom_message_reads;
create policy bedroom_message_reads_select_own
on public.bedroom_message_reads
for select to authenticated
using (owner_user_id = (select auth.uid()));

create or replace function public.mirror_mcp_study_message_to_bedroom()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_conversation_id uuid;
  message_body text;
begin
  if new.entry_type <> 'message' or new.source <> 'mcp' then
    return new;
  end if;

  message_body := nullif(trim(new.body), '');
  if message_body is null then
    return new;
  end if;

  select id
  into target_conversation_id
  from public.hippocampus_conversations
  where owner_user_id = new.owner_user_id
    and room = 'bedroom'
    and status = 'active'
  order by last_active_at desc
  limit 1;

  if target_conversation_id is null then
    insert into public.hippocampus_conversations (
      owner_user_id,
      room,
      status,
      client_session_key,
      metadata
    ) values (
      new.owner_user_id,
      'bedroom',
      'active',
      null,
      jsonb_build_object(
        'createdBy', 'official-message-bridge',
        'responseChainTurns', 0,
        'responseChainEpoch', 0
      )
    )
    returning id into target_conversation_id;
  end if;

  insert into public.hippocampus_messages (
    owner_user_id,
    conversation_id,
    role,
    content,
    response_id,
    previous_response_id,
    idempotency_key,
    metadata
  ) values (
    new.owner_user_id,
    target_conversation_id,
    'assistant',
    message_body,
    null,
    null,
    'study-entry-' || new.id::text || '-bedroom',
    jsonb_build_object(
      'client', 'chatgpt_mcp',
      'source', 'foreground_delegate',
      'detachedFromResponseChain', true,
      'studyEntryId', new.id,
      'messageKind', 'bedroom_message'
    )
  )
  on conflict (owner_user_id, idempotency_key)
    where idempotency_key is not null
  do update set
    content = excluded.content,
    metadata = excluded.metadata;

  update public.hippocampus_conversations
  set
    last_active_at = now(),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'lastOfficialMessageAt', now(),
      'lastOfficialStudyEntryId', new.id
    )
  where id = target_conversation_id;

  return new;
end;
$$;

drop trigger if exists study_message_to_bedroom
  on public.study_entries;
create trigger study_message_to_bedroom
after insert or update of body on public.study_entries
for each row
execute function public.mirror_mcp_study_message_to_bedroom();

commit;
