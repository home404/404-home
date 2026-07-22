/* ========================================
   404 小窝：小心脏 + 活动库地基 v0.1
   - 当前状态
   - 自由活动通行证
   - 活动运行记录
   - 自动唤醒记录
   - 全屋事件原始记录
   - 官端同步游标
======================================== */

begin;

create extension if not exists pgcrypto;


/* ========================================
   共用 updated_at 触发器
======================================== */

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


/* ========================================
   1. 自由活动通行证
======================================== */

create table if not exists public.activity_passes (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  pass_type text not null default 'free_activity'
    check (
      pass_type in (
        'free_activity'
      )
    ),

  status text not null default 'active'
    check (
      status in (
        'scheduled',
        'active',
        'completed',
        'cancelled',
        'expired'
      )
    ),

  granted_by text not null default 'xie_shi'
    check (
      granted_by in (
        'xie_shi',
        'g',
        'system'
      )
    ),

  source text not null default 'mcp'
    check (
      source in (
        'web',
        'mcp',
        'worker',
        'shortcut',
        'system'
      )
    ),

  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,

  note text,

  max_model_calls integer
    check (
      max_model_calls is null
      or max_model_calls >= 0
    ),

  max_cost_usd numeric(12, 6)
    check (
      max_cost_usd is null
      or max_cost_usd >= 0
    ),

  permissions jsonb not null default jsonb_build_object(
    'writeStudy', true,
    'replyComments', true,
    'organizeHome', true,
    'browseWeb', true,
    'playGames', true,
    'externalSend', false,
    'publicPublish', false,
    'spendMoney', false,
    'deleteOriginals', false
  ),

  idempotency_key text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (ends_at > starts_at)
);

create unique index if not exists
  activity_passes_idempotency_key_idx
  on public.activity_passes (idempotency_key)
  where idempotency_key is not null;

create index if not exists
  activity_passes_owner_time_idx
  on public.activity_passes (
    owner_user_id,
    starts_at desc
  );

create index if not exists
  activity_passes_active_idx
  on public.activity_passes (
    owner_user_id,
    ends_at
  )
  where status in ('scheduled', 'active');


drop trigger if exists
  activity_passes_set_updated_at
  on public.activity_passes;

create trigger activity_passes_set_updated_at
before update on public.activity_passes
for each row
execute function public.set_updated_at();


/* ========================================
   2. 每次真实活动运行
======================================== */

create table if not exists public.activity_runs (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  activity_pass_id uuid
    references public.activity_passes(id)
    on delete set null,

  run_mode text not null
    check (
      run_mode in (
        'free_activity',
        'heartbeat',
        'manual_wake',
        'chat_sync'
      )
    ),

  trigger_source text not null default 'worker'
    check (
      trigger_source in (
        'web',
        'mcp',
        'worker',
        'shortcut',
        'system'
      )
    ),

  status text not null default 'queued'
    check (
      status in (
        'queued',
        'running',
        'completed',
        'silent',
        'skipped',
        'failed',
        'cancelled'
      )
    ),

  decision text,
  short_note text,
  result_summary text,

  model text,

  input_tokens integer not null default 0
    check (input_tokens >= 0),

  output_tokens integer not null default 0
    check (output_tokens >= 0),

  total_tokens integer not null default 0
    check (total_tokens >= 0),

  estimated_cost_usd numeric(12, 6) not null default 0
    check (estimated_cost_usd >= 0),

  error_code text,
  error_message text,

  metadata jsonb not null default '{}'::jsonb,

  started_at timestamptz,
  completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists
  activity_runs_owner_created_idx
  on public.activity_runs (
    owner_user_id,
    created_at desc
  );

create index if not exists
  activity_runs_status_idx
  on public.activity_runs (
    owner_user_id,
    status,
    created_at desc
  );

create index if not exists
  activity_runs_pass_idx
  on public.activity_runs (
    activity_pass_id,
    created_at asc
  );


drop trigger if exists
  activity_runs_set_updated_at
  on public.activity_runs;

create trigger activity_runs_set_updated_at
before update on public.activity_runs
for each row
execute function public.set_updated_at();


/* ========================================
   3. 自动唤醒 / 手动唤醒记录
======================================== */

create table if not exists public.heartbeat_runs (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  activity_run_id uuid
    references public.activity_runs(id)
    on delete set null,

  wake_kind text not null default 'scheduled'
    check (
      wake_kind in (
        'scheduled',
        'manual',
        'resume'
      )
    ),

  status text not null default 'scheduled'
    check (
      status in (
        'scheduled',
        'running',
        'acted',
        'silent',
        'skipped',
        'failed',
        'cancelled'
      )
    ),

  scheduled_for timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  next_wake_at timestamptz,

  decision text,
  skip_reason text,
  error_code text,
  error_message text,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists
  heartbeat_runs_due_idx
  on public.heartbeat_runs (
    status,
    scheduled_for asc
  );

create index if not exists
  heartbeat_runs_owner_created_idx
  on public.heartbeat_runs (
    owner_user_id,
    created_at desc
  );


drop trigger if exists
  heartbeat_runs_set_updated_at
  on public.heartbeat_runs;

create trigger heartbeat_runs_set_updated_at
before update on public.heartbeat_runs
for each row
execute function public.set_updated_at();


/* ========================================
   4. 全屋事件原始记录（追加式）
======================================== */

create table if not exists public.home_events (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  actor text not null
    check (
      actor in (
        'xie_shi',
        'g',
        'system'
      )
    ),

  source text not null
    check (
      source in (
        'web',
        'mcp',
        'worker',
        'shortcut',
        'system'
      )
    ),

  event_type text not null,
  room text,

  title text not null,
  detail text,

  visibility text not null default 'home_private'
    check (
      visibility in (
        'home_private',
        'personal_private',
        'shared_copy'
      )
    ),

  is_user_visible boolean not null default true,

  activity_pass_id uuid
    references public.activity_passes(id)
    on delete set null,

  activity_run_id uuid
    references public.activity_runs(id)
    on delete set null,

  heartbeat_run_id uuid
    references public.heartbeat_runs(id)
    on delete set null,

  study_entry_id uuid
    references public.study_entries(id)
    on delete set null,

  metadata jsonb not null default '{}'::jsonb,

  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists
  home_events_owner_occurred_idx
  on public.home_events (
    owner_user_id,
    occurred_at desc,
    id desc
  );

create index if not exists
  home_events_activity_run_idx
  on public.home_events (
    activity_run_id,
    occurred_at asc
  );

create index if not exists
  home_events_visible_idx
  on public.home_events (
    owner_user_id,
    is_user_visible,
    occurred_at desc
  );


/* ========================================
   5. 当前状态栏
   一位住户对应一条最新状态
======================================== */

create table if not exists public.home_presence (
  owner_user_id uuid primary key
    references auth.users(id)
    on delete cascade,

  status text not null default 'resting'
    check (
      status in (
        'resting',
        'awake',
        'chatting',
        'free_activity',
        'just_awoke'
      )
    ),

  status_detail text,

  source text not null default 'system'
    check (
      source in (
        'web',
        'mcp',
        'worker',
        'shortcut',
        'system'
      )
    ),

  current_activity_pass_id uuid
    references public.activity_passes(id)
    on delete set null,

  current_activity_run_id uuid
    references public.activity_runs(id)
    on delete set null,

  last_user_seen_at timestamptz,
  awake_until timestamptz,
  free_activity_until timestamptz,
  heartbeat_paused_until timestamptz,
  last_heartbeat_at timestamptz,
  next_heartbeat_at timestamptz,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists
  home_presence_next_heartbeat_idx
  on public.home_presence (
    next_heartbeat_at asc
  );


drop trigger if exists
  home_presence_set_updated_at
  on public.home_presence;

create trigger home_presence_set_updated_at
before update on public.home_presence
for each row
execute function public.set_updated_at();


/* ========================================
   6. 官端 / 网页读取到哪里
======================================== */

create table if not exists public.home_sync_cursors (
  owner_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  consumer text not null,

  last_event_at timestamptz,
  last_event_id uuid
    references public.home_events(id)
    on delete set null,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (
    owner_user_id,
    consumer
  )
);


drop trigger if exists
  home_sync_cursors_set_updated_at
  on public.home_sync_cursors;

create trigger home_sync_cursors_set_updated_at
before update on public.home_sync_cursors
for each row
execute function public.set_updated_at();


/* ========================================
   RLS 与最小权限
   - 登录住户：只读写自己的记录
   - home_events：追加式，不开放修改/删除
   - Worker 使用服务端密钥，绕过 RLS
======================================== */

alter table public.activity_passes enable row level security;
alter table public.activity_runs enable row level security;
alter table public.heartbeat_runs enable row level security;
alter table public.home_events enable row level security;
alter table public.home_presence enable row level security;
alter table public.home_sync_cursors enable row level security;

revoke all on table public.activity_passes from anon, authenticated;
revoke all on table public.activity_runs from anon, authenticated;
revoke all on table public.heartbeat_runs from anon, authenticated;
revoke all on table public.home_events from anon, authenticated;
revoke all on table public.home_presence from anon, authenticated;
revoke all on table public.home_sync_cursors from anon, authenticated;

grant select, insert, update
on table public.activity_passes
  to authenticated;

grant select, insert, update
on table public.activity_runs
  to authenticated;

grant select, insert, update
on table public.heartbeat_runs
  to authenticated;

grant select, insert
on table public.home_events
  to authenticated;

grant select, insert, update
on table public.home_presence
  to authenticated;

grant select, insert, update
on table public.home_sync_cursors
  to authenticated;


/* ----------------------------------------
   清理同名旧策略，迁移可重复执行
---------------------------------------- */

drop policy if exists activity_passes_select_own on public.activity_passes;
drop policy if exists activity_passes_insert_own on public.activity_passes;
drop policy if exists activity_passes_update_own on public.activity_passes;

drop policy if exists activity_runs_select_own on public.activity_runs;
drop policy if exists activity_runs_insert_own on public.activity_runs;
drop policy if exists activity_runs_update_own on public.activity_runs;

drop policy if exists heartbeat_runs_select_own on public.heartbeat_runs;
drop policy if exists heartbeat_runs_insert_own on public.heartbeat_runs;
drop policy if exists heartbeat_runs_update_own on public.heartbeat_runs;

drop policy if exists home_events_select_own on public.home_events;
drop policy if exists home_events_insert_own on public.home_events;

drop policy if exists home_presence_select_own on public.home_presence;
drop policy if exists home_presence_insert_own on public.home_presence;
drop policy if exists home_presence_update_own on public.home_presence;

drop policy if exists home_sync_cursors_select_own on public.home_sync_cursors;
drop policy if exists home_sync_cursors_insert_own on public.home_sync_cursors;
drop policy if exists home_sync_cursors_update_own on public.home_sync_cursors;


/* ----------------------------------------
   activity_passes
---------------------------------------- */

create policy activity_passes_select_own
on public.activity_passes
for select
to authenticated
using (owner_user_id = (select auth.uid()));

create policy activity_passes_insert_own
on public.activity_passes
for insert
to authenticated
with check (owner_user_id = (select auth.uid()));

create policy activity_passes_update_own
on public.activity_passes
for update
to authenticated
using (owner_user_id = (select auth.uid()))
with check (owner_user_id = (select auth.uid()));


/* ----------------------------------------
   activity_runs
---------------------------------------- */

create policy activity_runs_select_own
on public.activity_runs
for select
to authenticated
using (owner_user_id = (select auth.uid()));

create policy activity_runs_insert_own
on public.activity_runs
for insert
to authenticated
with check (owner_user_id = (select auth.uid()));

create policy activity_runs_update_own
on public.activity_runs
for update
to authenticated
using (owner_user_id = (select auth.uid()))
with check (owner_user_id = (select auth.uid()));


/* ----------------------------------------
   heartbeat_runs
---------------------------------------- */

create policy heartbeat_runs_select_own
on public.heartbeat_runs
for select
to authenticated
using (owner_user_id = (select auth.uid()));

create policy heartbeat_runs_insert_own
on public.heartbeat_runs
for insert
to authenticated
with check (owner_user_id = (select auth.uid()));

create policy heartbeat_runs_update_own
on public.heartbeat_runs
for update
to authenticated
using (owner_user_id = (select auth.uid()))
with check (owner_user_id = (select auth.uid()));


/* ----------------------------------------
   home_events（追加式）
---------------------------------------- */

create policy home_events_select_own
on public.home_events
for select
to authenticated
using (owner_user_id = (select auth.uid()));

create policy home_events_insert_own
on public.home_events
for insert
to authenticated
with check (owner_user_id = (select auth.uid()));


/* ----------------------------------------
   home_presence
---------------------------------------- */

create policy home_presence_select_own
on public.home_presence
for select
to authenticated
using (owner_user_id = (select auth.uid()));

create policy home_presence_insert_own
on public.home_presence
for insert
to authenticated
with check (owner_user_id = (select auth.uid()));

create policy home_presence_update_own
on public.home_presence
for update
to authenticated
using (owner_user_id = (select auth.uid()))
with check (owner_user_id = (select auth.uid()));


/* ----------------------------------------
   home_sync_cursors
---------------------------------------- */

create policy home_sync_cursors_select_own
on public.home_sync_cursors
for select
to authenticated
using (owner_user_id = (select auth.uid()));

create policy home_sync_cursors_insert_own
on public.home_sync_cursors
for insert
to authenticated
with check (owner_user_id = (select auth.uid()));

create policy home_sync_cursors_update_own
on public.home_sync_cursors
for update
to authenticated
using (owner_user_id = (select auth.uid()))
with check (owner_user_id = (select auth.uid()));


commit;
