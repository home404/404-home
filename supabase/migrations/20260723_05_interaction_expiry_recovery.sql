begin;


/* ========================================
   连接桥漏发“关闭”时的恢复与缓冲

   - App 正常关闭：API 立即结束互动并按选择续接；
   - 关闭信号丢失：互动租约过期后触发本函数；
   - 若活动选择 after_chat，则按真正剩余时间续上；
   - 没有活动或活动不自动续接时，仍保留 15 分钟聊天缓冲；
   - 整个过程只更新数据库，不调用模型；
   - 若还有另一条有效互动，则继续保持互动状态。
======================================== */


create or replace function
  public.recover_free_activity_after_interaction_expiry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  progress_row public.free_activity_progress%rowtype;
  pass_row public.activity_passes%rowtype;
  remaining_seconds integer;
  recovered_end timestamptz;
  grace_until timestamptz :=
    now() + interval '15 minutes';
  progress_found boolean := false;
begin
  if not (
    old.status = 'active' and
    new.status = 'expired'
  ) then
    return new;
  end if;

  if exists (
    select 1
    from public.home_interaction_sessions session
    where session.owner_user_id = new.owner_user_id
      and session.status = 'active'
      and session.expires_at > now()
  ) then
    return new;
  end if;

  select progress.*
  into progress_row
  from public.free_activity_progress progress
  where progress.owner_user_id = new.owner_user_id
    and progress.state = 'paused_by_chat'
  order by progress.updated_at desc
  limit 1
  for update;

  progress_found := found;

  if progress_found and
     progress_row.resume_policy = 'after_chat' then
    select pass.*
    into pass_row
    from public.activity_passes pass
    where pass.id = progress_row.activity_pass_id
      and pass.owner_user_id = new.owner_user_id
      and pass.status in ('scheduled', 'active')
    for update;

    if found then
      remaining_seconds := greatest(
        0,
        progress_row.active_seconds_budget -
        progress_row.active_seconds_used
      );

      if remaining_seconds > 0 then
        recovered_end :=
          now() + make_interval(secs => remaining_seconds);

        update public.free_activity_progress
        set
          state = 'running',
          pause_reason = null,
          paused_at = null,
          last_resumed_at = now(),
          metadata = coalesce(metadata, '{}'::jsonb) ||
            jsonb_build_object(
              'recoveredFromExpiredInteraction', new.id,
              'recoveredAt', now()
            ),
          updated_at = now()
        where activity_pass_id =
          progress_row.activity_pass_id;

        update public.activity_passes
        set
          status = 'active',
          ends_at = recovered_end
        where id = progress_row.activity_pass_id
          and owner_user_id = new.owner_user_id;

        insert into public.home_presence (
          owner_user_id,
          status,
          status_detail,
          source,
          current_activity_pass_id,
          current_activity_run_id,
          awake_until,
          free_activity_until,
          heartbeat_paused_until,
          next_heartbeat_at,
          metadata
        )
        values (
          new.owner_user_id,
          'free_activity',
          'G 回到客厅继续自由活动',
          'interaction_expiry_recovery',
          progress_row.activity_pass_id,
          null,
          null,
          recovered_end,
          null,
          now(),
          jsonb_build_object(
            'mode', 'free_activity_running',
            'recoveredFromExpiredInteraction', new.id,
            'timeAccounting', 'active_seconds_only'
          )
        )
        on conflict (owner_user_id)
        do update set
          status = excluded.status,
          status_detail = excluded.status_detail,
          source = excluded.source,
          current_activity_pass_id =
            excluded.current_activity_pass_id,
          current_activity_run_id = null,
          awake_until = null,
          free_activity_until =
            excluded.free_activity_until,
          heartbeat_paused_until = null,
          next_heartbeat_at =
            excluded.next_heartbeat_at,
          metadata = excluded.metadata;

        insert into public.home_events (
          owner_user_id,
          actor,
          source,
          event_type,
          room,
          title,
          detail,
          visibility,
          is_user_visible,
          activity_pass_id,
          metadata
        )
        values (
          new.owner_user_id,
          'system',
          'interaction_expiry_recovery',
          'free_activity_resumed_after_lease_expiry',
          'living_room',
          '聊天连接已过期，继续自由活动',
          '连接桥没有收到关闭信号，故障租约到期后按原选择续上。',
          'home_private',
          true,
          progress_row.activity_pass_id,
          jsonb_build_object(
            'interactionSessionId', new.id,
            'remainingSeconds', remaining_seconds,
            'recoveredEnd', recovered_end
          )
        );

        return new;
      end if;

      update public.free_activity_progress
      set
        state = 'paused_by_time',
        pause_reason = 'active_time_budget_reached',
        paused_at = now(),
        last_resumed_at = null,
        updated_at = now()
      where activity_pass_id =
        progress_row.activity_pass_id;

      progress_row.state := 'paused_by_time';
    end if;
  end if;

  /*
    没有可自动续接的活动时，也不能在故障租约过期后立刻允许
    自动心跳。先进入与正常关闭一致的 15 分钟聊天缓冲。
  */
  insert into public.home_presence (
    owner_user_id,
    status,
    status_detail,
    source,
    current_activity_pass_id,
    current_activity_run_id,
    awake_until,
    free_activity_until,
    heartbeat_paused_until,
    next_heartbeat_at,
    metadata
  )
  values (
    new.owner_user_id,
    'resting',
    case
      when progress_found then
        'G 已离开互动，未完成事项仍保存在客厅'
      else
        'G 在卧室休息'
    end,
    'interaction_expiry_grace',
    case
      when progress_found then
        progress_row.activity_pass_id
      else null
    end,
    null,
    null,
    null,
    grace_until,
    grace_until,
    jsonb_build_object(
      'mode', 'post_chat_grace',
      'expiredInteractionSessionId', new.id,
      'graceUntil', grace_until,
      'pausedActivityState',
        case
          when progress_found then progress_row.state
          else null
        end
    )
  )
  on conflict (owner_user_id)
  do update set
    status = excluded.status,
    status_detail = excluded.status_detail,
    source = excluded.source,
    current_activity_pass_id =
      excluded.current_activity_pass_id,
    current_activity_run_id = null,
    awake_until = null,
    free_activity_until = null,
    heartbeat_paused_until =
      excluded.heartbeat_paused_until,
    next_heartbeat_at =
      excluded.next_heartbeat_at,
    metadata = excluded.metadata;

  insert into public.home_events (
    owner_user_id,
    actor,
    source,
    event_type,
    room,
    title,
    detail,
    visibility,
    is_user_visible,
    activity_pass_id,
    metadata
  )
  values (
    new.owner_user_id,
    'system',
    'interaction_expiry_grace',
    'post_chat_grace_started_after_lease_expiry',
    null,
    '聊天故障租约已过期',
    '连接桥没有收到关闭信号，先进入 15 分钟聊天缓冲。',
    'home_private',
    false,
    case
      when progress_found then
        progress_row.activity_pass_id
      else null
    end,
    jsonb_build_object(
      'interactionSessionId', new.id,
      'graceUntil', grace_until
    )
  );

  return new;
end;
$$;


 drop trigger if exists
  home_interaction_sessions_recover_activity
  on public.home_interaction_sessions;

create trigger
  home_interaction_sessions_recover_activity
after update of status
on public.home_interaction_sessions
for each row
execute function
  public.recover_free_activity_after_interaction_expiry();


revoke all on function
  public.recover_free_activity_after_interaction_expiry()
  from public, anon, authenticated;


commit;
