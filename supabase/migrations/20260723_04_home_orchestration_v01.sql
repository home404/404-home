begin;


/* ========================================
   404 全屋调度器 v0.1

   目标：
   1. 官端 / 卧室互动拥有最高优先级；
   2. 互动开始时暂停自由活动，但不消耗剩余活动时间；
   3. 自由活动进度、时间与 token / 费用预算可保存、续接；
   4. 自动心跳在完整功能验收前默认保持关闭；
   5. 连接桥只登记清醒状态，不调用模型。
======================================== */


create table if not exists public.home_runtime_settings (
  owner_user_id uuid primary key
    references auth.users(id)
    on delete cascade,

  interaction_lease_seconds integer not null default 300
    check (interaction_lease_seconds between 60 and 7200),

  heartbeat_input_token_budget integer not null default 8000
    check (heartbeat_input_token_budget between 1000 and 100000),

  heartbeat_max_output_tokens integer not null default 24000
    check (heartbeat_max_output_tokens between 1000 and 128000),

  heartbeat_reasoning_effort text not null default 'medium'
    check (heartbeat_reasoning_effort in ('none', 'low', 'medium', 'high', 'xhigh')),

  automatic_heartbeat_release_enabled boolean not null default false,
  auto_resume_free_activity_after_chat boolean not null default true,

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


drop trigger if exists
  home_runtime_settings_set_updated_at
  on public.home_runtime_settings;

create trigger home_runtime_settings_set_updated_at
before update on public.home_runtime_settings
for each row
execute function public.set_updated_at();


create table if not exists public.home_interaction_sessions (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  channel text not null
    check (
      channel in (
        'official_chat',
        'bedroom_chat',
        'interactive_game',
        'interactive_tool'
      )
    ),

  status text not null default 'active'
    check (status in ('active', 'ended', 'expired')),

  source text not null default 'shortcut',
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,

  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


create unique index if not exists
  home_interaction_sessions_owner_channel_active_uidx
  on public.home_interaction_sessions (
    owner_user_id,
    channel
  )
  where status = 'active';

create unique index if not exists
  home_interaction_sessions_idempotency_uidx
  on public.home_interaction_sessions (
    owner_user_id,
    idempotency_key
  )
  where idempotency_key is not null;

create index if not exists
  home_interaction_sessions_owner_expiry_idx
  on public.home_interaction_sessions (
    owner_user_id,
    status,
    expires_at desc
  );


drop trigger if exists
  home_interaction_sessions_set_updated_at
  on public.home_interaction_sessions;

create trigger home_interaction_sessions_set_updated_at
before update on public.home_interaction_sessions
for each row
execute function public.set_updated_at();


/* ----------------------------------------
   自由活动进度与暂停状态

   active_seconds_budget 表示真正活动时间，
   官端 / 卧室互动期间不继续扣减。
---------------------------------------- */

create unique index if not exists
  activity_passes_id_owner_uidx
  on public.activity_passes (
    id,
    owner_user_id
  );


create table if not exists public.free_activity_progress (
  activity_pass_id uuid primary key,

  owner_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  state text not null default 'running'
    check (
      state in (
        'running',
        'paused_by_chat',
        'paused_by_time',
        'paused_by_budget',
        'paused_manual',
        'handed_to_interactive',
        'completed',
        'cancelled'
      )
    ),

  active_seconds_budget integer not null
    check (active_seconds_budget between 60 and 2592000),

  active_seconds_used integer not null default 0
    check (active_seconds_used >= 0),

  last_resumed_at timestamptz,
  paused_at timestamptz,
  pause_reason text,

  resume_policy text not null default 'after_chat'
    check (
      resume_policy in (
        'after_chat',
        'interactive_handoff',
        'manual'
      )
    ),

  current_task text,
  progress_summary text,
  progress_data jsonb not null default '{}'::jsonb,

  input_token_budget integer
    check (input_token_budget is null or input_token_budget >= 0),
  output_token_budget integer
    check (output_token_budget is null or output_token_budget >= 0),
  input_tokens_used integer not null default 0
    check (input_tokens_used >= 0),
  output_tokens_used integer not null default 0
    check (output_tokens_used >= 0),

  max_cost_usd numeric(12, 6)
    check (max_cost_usd is null or max_cost_usd >= 0),
  estimated_cost_usd numeric(12, 6) not null default 0
    check (estimated_cost_usd >= 0),

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint free_activity_progress_pass_owner_fk
    foreign key (
      activity_pass_id,
      owner_user_id
    )
    references public.activity_passes (
      id,
      owner_user_id
    )
    on delete cascade,

  constraint free_activity_progress_time_check
    check (active_seconds_used <= active_seconds_budget)
);


create index if not exists
  free_activity_progress_owner_state_idx
  on public.free_activity_progress (
    owner_user_id,
    state,
    updated_at desc
  );


drop trigger if exists
  free_activity_progress_set_updated_at
  on public.free_activity_progress;

create trigger free_activity_progress_set_updated_at
before update on public.free_activity_progress
for each row
execute function public.set_updated_at();


/* ========================================
   RLS 与最小权限
======================================== */

alter table public.home_runtime_settings
  enable row level security;
alter table public.home_interaction_sessions
  enable row level security;
alter table public.free_activity_progress
  enable row level security;

revoke all
on table
  public.home_runtime_settings,
  public.home_interaction_sessions,
  public.free_activity_progress
from anon, authenticated;

grant select, insert, update
on table
  public.home_runtime_settings,
  public.home_interaction_sessions,
  public.free_activity_progress
to authenticated;


do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'home_runtime_settings',
    'home_interaction_sessions',
    'free_activity_progress'
  ]
  loop
    execute format(
      'drop policy if exists %I on public.%I',
      target_table || '_select_own',
      target_table
    );

    execute format(
      'drop policy if exists %I on public.%I',
      target_table || '_insert_own',
      target_table
    );

    execute format(
      'drop policy if exists %I on public.%I',
      target_table || '_update_own',
      target_table
    );

    execute format(
      'create policy %I on public.%I for select to authenticated using (owner_user_id = (select auth.uid()))',
      target_table || '_select_own',
      target_table
    );

    execute format(
      'create policy %I on public.%I for insert to authenticated with check (owner_user_id = (select auth.uid()))',
      target_table || '_insert_own',
      target_table
    );

    execute format(
      'create policy %I on public.%I for update to authenticated using (owner_user_id = (select auth.uid())) with check (owner_user_id = (select auth.uid()))',
      target_table || '_update_own',
      target_table
    );
  end loop;
end;
$$;


comment on table public.home_interaction_sessions
is '连接桥与卧室聊天的短期清醒登记；登记本身不调用模型';

comment on table public.free_activity_progress
is '自由活动真正活动时长、暂停续接、任务进度与 token / 费用预算';

comment on column public.home_runtime_settings.automatic_heartbeat_release_enabled
is '完整功能验收前保持 false；用于防止半成品进入日常自动运行';


commit;
