begin;


/* ========================================
   自动心跳 Worker 抢占与租约
   - 多实例只允许一个 Worker 取得同一位住户的到期心跳
   - Worker 异常退出后，租约到期可重新抢占
   - 自动心跳关闭时，仅有效自由活动通行证可以继续唤醒
======================================== */

alter table public.home_presence
  add column if not exists heartbeat_claim_token uuid,
  add column if not exists heartbeat_claimed_at timestamptz,
  add column if not exists heartbeat_lease_until timestamptz;


create index if not exists
  home_presence_heartbeat_lease_idx
  on public.home_presence (
    heartbeat_lease_until asc
  )
  where heartbeat_claim_token is not null;


create or replace function public.claim_due_heartbeats(
  p_limit integer default 4,
  p_lease_seconds integer default 900
)
returns table (
  owner_user_id uuid,
  claim_token uuid,
  due_at timestamptz,
  lease_until timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with candidates as materialized (
    select
      hp.owner_user_id,
      hp.next_heartbeat_at as due_at
    from public.home_presence hp
    left join public.heartbeat_preferences pref
      on pref.owner_user_id = hp.owner_user_id
    where
      hp.next_heartbeat_at is not null
      and hp.next_heartbeat_at <= now()
      and (
        hp.heartbeat_lease_until is null
        or hp.heartbeat_lease_until <= now()
      )
      and (
        exists (
          select 1
          from public.activity_passes ap
          where
            ap.owner_user_id = hp.owner_user_id
            and ap.status in ('scheduled', 'active')
            and ap.starts_at <= now()
            and ap.ends_at > now()
        )
        or (
          coalesce(
            pref.auto_heartbeat_enabled,
            false
          )
          and hp.status <> 'chatting'
          and (
            hp.heartbeat_paused_until is null
            or hp.heartbeat_paused_until <= now()
          )
        )
      )
    order by
      hp.next_heartbeat_at asc,
      hp.owner_user_id asc
    for update of hp skip locked
    limit greatest(
      1,
      least(
        coalesce(p_limit, 4),
        20
      )
    )
  ),
  claimed as (
    update public.home_presence hp
    set
      heartbeat_claim_token = gen_random_uuid(),
      heartbeat_claimed_at = now(),
      heartbeat_lease_until =
        now() + make_interval(
          secs => greatest(
            120,
            least(
              coalesce(p_lease_seconds, 900),
              3600
            )
          )
        )
    from candidates c
    where hp.owner_user_id = c.owner_user_id
    returning
      hp.owner_user_id,
      hp.heartbeat_claim_token,
      c.due_at,
      hp.heartbeat_lease_until
  )
  select
    claimed.owner_user_id,
    claimed.heartbeat_claim_token,
    claimed.due_at,
    claimed.heartbeat_lease_until
  from claimed;
$$;


revoke all
on function public.claim_due_heartbeats(integer, integer)
from public, anon, authenticated;

grant execute
on function public.claim_due_heartbeats(integer, integer)
to service_role;


commit;
