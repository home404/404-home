begin;


/* ========================================
   小心脏作息与自动唤醒偏好
   - 默认关闭自动心跳，完成 Worker 验收后再由屋主开启
   - 支持跨午夜休息时段
   - 固定间隔使用 min = max
======================================== */

create table if not exists public.heartbeat_preferences (
  owner_user_id uuid primary key
    references auth.users(id)
    on delete cascade,

  auto_heartbeat_enabled boolean not null default false,

  timezone text not null default 'Asia/Shanghai'
    check (char_length(timezone) between 1 and 100),

  quiet_hours_enabled boolean not null default true,
  quiet_start time without time zone not null default time '02:00',
  quiet_end time without time zone not null default time '05:00',

  interval_min_minutes integer not null default 30
    check (interval_min_minutes between 15 and 720),

  interval_max_minutes integer not null default 50
    check (interval_max_minutes between 15 and 720),

  post_chat_grace_minutes integer not null default 15
    check (post_chat_grace_minutes between 0 and 120),

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (interval_min_minutes <= interval_max_minutes),
  check (quiet_start <> quiet_end)
);


drop trigger if exists
  heartbeat_preferences_set_updated_at
  on public.heartbeat_preferences;

create trigger heartbeat_preferences_set_updated_at
before update on public.heartbeat_preferences
for each row
execute function public.set_updated_at();


/* ========================================
   RLS 与最小权限
======================================== */

alter table public.heartbeat_preferences
  enable row level security;

revoke all
on table public.heartbeat_preferences
from anon, authenticated;

grant select, insert, update
on table public.heartbeat_preferences
to authenticated;


drop policy if exists
  heartbeat_preferences_select_own
  on public.heartbeat_preferences;

drop policy if exists
  heartbeat_preferences_insert_own
  on public.heartbeat_preferences;

drop policy if exists
  heartbeat_preferences_update_own
  on public.heartbeat_preferences;


create policy heartbeat_preferences_select_own
on public.heartbeat_preferences
for select
to authenticated
using (owner_user_id = (select auth.uid()));

create policy heartbeat_preferences_insert_own
on public.heartbeat_preferences
for insert
to authenticated
with check (owner_user_id = (select auth.uid()));

create policy heartbeat_preferences_update_own
on public.heartbeat_preferences
for update
to authenticated
using (owner_user_id = (select auth.uid()))
with check (owner_user_id = (select auth.uid()));


commit;
