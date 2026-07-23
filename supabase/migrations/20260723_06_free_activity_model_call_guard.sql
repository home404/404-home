begin;


/* ========================================
   自由活动模型调用次数保险丝

   Worker 每完成一次模型调用，activity_runs 会从 running
   变为 completed / silent / failed。本触发器在该时刻统计
   本张通行证已经实际消耗的调用次数；达到上限后立即暂停
   free_activity_progress，使下一轮 Worker 在调用模型之前
   就被全屋调度器拦下。
======================================== */


create or replace function
  public.enforce_free_activity_model_call_budget()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  max_calls integer;
  used_calls integer;
begin
  if new.activity_pass_id is null then
    return new;
  end if;

  if new.status not in (
    'completed',
    'silent',
    'failed'
  ) then
    return new;
  end if;

  if old.status is not distinct from new.status then
    return new;
  end if;

  select pass.max_model_calls
  into max_calls
  from public.activity_passes pass
  where pass.id = new.activity_pass_id
    and pass.owner_user_id = new.owner_user_id;

  if max_calls is null then
    return new;
  end if;

  select count(*)::integer
  into used_calls
  from public.activity_runs run
  where run.activity_pass_id =
      new.activity_pass_id
    and run.owner_user_id =
      new.owner_user_id
    and run.status in (
      'running',
      'completed',
      'silent',
      'failed'
    );

  if used_calls < max_calls then
    return new;
  end if;

  update public.free_activity_progress
  set
    state = 'paused_by_budget',
    pause_reason =
      'model_call_budget_exhausted',
    paused_at = now(),
    last_resumed_at = null,
    progress_data =
      coalesce(progress_data, '{}'::jsonb) ||
      jsonb_build_object(
        'modelCallsUsed', used_calls,
        'modelCallsBudget', max_calls,
        'modelCallBudgetReachedAt', now()
      ),
    updated_at = now()
  where activity_pass_id =
      new.activity_pass_id
    and owner_user_id =
      new.owner_user_id
    and state not in (
      'completed',
      'cancelled'
    );

  update public.home_presence
  set
    status = 'free_activity',
    status_detail =
      'G 的自由活动已暂停：模型调用次数到达上限',
    source =
      'model_call_budget_guard',
    current_activity_pass_id =
      new.activity_pass_id,
    current_activity_run_id = null,
    next_heartbeat_at =
      now() + interval '15 minutes',
    metadata =
      coalesce(metadata, '{}'::jsonb) ||
      jsonb_build_object(
        'mode', 'free_activity_paused',
        'pauseReason',
          'model_call_budget_exhausted',
        'modelCallsUsed', used_calls,
        'modelCallsBudget', max_calls
      )
  where owner_user_id = new.owner_user_id;

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
    activity_run_id,
    metadata
  )
  values (
    new.owner_user_id,
    'system',
    'model_call_budget_guard',
    'free_activity_paused_by_model_call_budget',
    'living_room',
    '自由活动调用次数已到上限',
    format(
      '已使用 %s / %s 次模型调用，进度已保存。',
      used_calls,
      max_calls
    ),
    'home_private',
    true,
    new.activity_pass_id,
    new.id,
    jsonb_build_object(
      'modelCallsUsed', used_calls,
      'modelCallsBudget', max_calls
    )
  );

  return new;
end;
$$;


drop trigger if exists
  activity_runs_enforce_model_call_budget
  on public.activity_runs;

create trigger
  activity_runs_enforce_model_call_budget
after update of status
on public.activity_runs
for each row
execute function
  public.enforce_free_activity_model_call_budget();


revoke all on function
  public.enforce_free_activity_model_call_budget()
  from public, anon, authenticated;


commit;
