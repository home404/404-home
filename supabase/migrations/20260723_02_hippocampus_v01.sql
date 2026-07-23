begin;


/* ========================================
   白狐狸海马体 v0.1

   原则：
   1. 原文永久保存，摘要不能覆盖原文；
   2. 所有记忆均归属于屋主；
   3. 长期记忆能够追溯来源；
   4. v0.1 先使用关键词、标签、重要度和时间检索；
   5. 后续可以在不改调用方的情况下加入 embedding。
======================================== */


create table if not exists public.hippocampus_conversations (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  room text not null default 'living_room',
  status text not null default 'active'
    check (status in ('active', 'archived', 'closed')),

  client_session_key text,
  latest_response_id text,

  started_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  closed_at timestamptz,

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists
  hippocampus_conversations_owner_client_key_uidx
  on public.hippocampus_conversations (
    owner_user_id,
    client_session_key
  )
  where client_session_key is not null;

create index if not exists
  hippocampus_conversations_owner_active_idx
  on public.hippocampus_conversations (
    owner_user_id,
    last_active_at desc
  );


drop trigger if exists
  hippocampus_conversations_set_updated_at
  on public.hippocampus_conversations;

create trigger hippocampus_conversations_set_updated_at
before update on public.hippocampus_conversations
for each row
execute function public.set_updated_at();


create table if not exists public.hippocampus_messages (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  conversation_id uuid not null
    references public.hippocampus_conversations(id)
    on delete cascade,

  role text not null
    check (role in ('user', 'assistant', 'system', 'tool')),

  content text not null
    check (char_length(content) between 1 and 100000),

  response_id text,
  previous_response_id text,

  input_tokens integer
    check (input_tokens is null or input_tokens >= 0),
  output_tokens integer
    check (output_tokens is null or output_tokens >= 0),
  total_tokens integer
    check (total_tokens is null or total_tokens >= 0),
  estimated_cost_usd numeric(12, 6)
    check (
      estimated_cost_usd is null or
      estimated_cost_usd >= 0
    ),

  occurred_at timestamptz not null default now(),
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists
  hippocampus_messages_idempotency_uidx
  on public.hippocampus_messages (
    owner_user_id,
    idempotency_key
  )
  where idempotency_key is not null;

create index if not exists
  hippocampus_messages_conversation_time_idx
  on public.hippocampus_messages (
    conversation_id,
    occurred_at asc
  );

create index if not exists
  hippocampus_messages_owner_recent_idx
  on public.hippocampus_messages (
    owner_user_id,
    occurred_at desc
  );


create table if not exists public.hippocampus_memories (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  memory_type text not null
    check (
      memory_type in (
        'identity_capsule',
        'recent_summary',
        'daily_summary',
        'long_term',
        'relationship',
        'preference',
        'project',
        'event_summary'
      )
    ),

  title text not null
    check (char_length(title) between 1 and 300),

  content text not null
    check (char_length(content) between 1 and 100000),

  summary text,
  tags text[] not null default '{}'::text[],

  importance smallint not null default 50
    check (importance between 0 and 100),

  source_type text,
  source_id text,
  source_ref jsonb not null default '{}'::jsonb,

  occurred_at timestamptz not null default now(),
  valid_from timestamptz,
  valid_until timestamptz,
  is_active boolean not null default true,

  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists
  hippocampus_memories_idempotency_uidx
  on public.hippocampus_memories (
    owner_user_id,
    idempotency_key
  )
  where idempotency_key is not null;

create index if not exists
  hippocampus_memories_owner_active_idx
  on public.hippocampus_memories (
    owner_user_id,
    is_active,
    importance desc,
    occurred_at desc
  );

create index if not exists
  hippocampus_memories_tags_gin_idx
  on public.hippocampus_memories
  using gin (tags);


drop trigger if exists
  hippocampus_memories_set_updated_at
  on public.hippocampus_memories;

create trigger hippocampus_memories_set_updated_at
before update on public.hippocampus_memories
for each row
execute function public.set_updated_at();


create table if not exists public.hippocampus_retrievals (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  consumer text not null,
  query_text text,
  selected_memory_ids uuid[] not null default '{}'::uuid[],
  selected_message_ids uuid[] not null default '{}'::uuid[],

  estimated_input_tokens integer not null default 0
    check (estimated_input_tokens >= 0),

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists
  hippocampus_retrievals_owner_created_idx
  on public.hippocampus_retrievals (
    owner_user_id,
    created_at desc
  );


/* ========================================
   RLS 与最小权限
======================================== */

alter table public.hippocampus_conversations
  enable row level security;
alter table public.hippocampus_messages
  enable row level security;
alter table public.hippocampus_memories
  enable row level security;
alter table public.hippocampus_retrievals
  enable row level security;

revoke all
on table
  public.hippocampus_conversations,
  public.hippocampus_messages,
  public.hippocampus_memories,
  public.hippocampus_retrievals
from anon, authenticated;

grant select, insert, update
on table
  public.hippocampus_conversations,
  public.hippocampus_messages,
  public.hippocampus_memories
  to authenticated;

grant select, insert
on table public.hippocampus_retrievals
  to authenticated;


do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'hippocampus_conversations',
    'hippocampus_messages',
    'hippocampus_memories',
    'hippocampus_retrievals'
  ]
  loop
    execute format(
      'drop policy if exists %I on public.%I',
      table_name || '_select_own',
      table_name
    );

    execute format(
      'drop policy if exists %I on public.%I',
      table_name || '_insert_own',
      table_name
    );

    execute format(
      'create policy %I on public.%I for select to authenticated using (owner_user_id = (select auth.uid()))',
      table_name || '_select_own',
      table_name
    );

    execute format(
      'create policy %I on public.%I for insert to authenticated with check (owner_user_id = (select auth.uid()))',
      table_name || '_insert_own',
      table_name
    );
  end loop;
end;
$$;


drop policy if exists
  hippocampus_conversations_update_own
  on public.hippocampus_conversations;
create policy hippocampus_conversations_update_own
on public.hippocampus_conversations
for update to authenticated
using (owner_user_id = (select auth.uid()))
with check (owner_user_id = (select auth.uid()));


drop policy if exists
  hippocampus_messages_update_own
  on public.hippocampus_messages;
create policy hippocampus_messages_update_own
on public.hippocampus_messages
for update to authenticated
using (owner_user_id = (select auth.uid()))
with check (owner_user_id = (select auth.uid()));


drop policy if exists
  hippocampus_memories_update_own
  on public.hippocampus_memories;
create policy hippocampus_memories_update_own
on public.hippocampus_memories
for update to authenticated
using (owner_user_id = (select auth.uid()))
with check (owner_user_id = (select auth.uid()));


commit;
