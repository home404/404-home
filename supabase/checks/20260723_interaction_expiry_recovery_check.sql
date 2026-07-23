select
  to_regprocedure(
    'public.recover_free_activity_after_interaction_expiry()'
  ) is not null as recovery_function_exists;


select exists (
  select 1
  from pg_trigger trigger_row
  join pg_class table_row
    on table_row.oid = trigger_row.tgrelid
  join pg_namespace namespace_row
    on namespace_row.oid = table_row.relnamespace
  where namespace_row.nspname = 'public'
    and table_row.relname =
      'home_interaction_sessions'
    and trigger_row.tgname =
      'home_interaction_sessions_recover_activity'
    and not trigger_row.tgisinternal
) as recovery_trigger_exists;


select
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'free_activity_progress'
  and column_name in (
    'state',
    'resume_policy',
    'active_seconds_budget',
    'active_seconds_used',
    'last_resumed_at',
    'paused_at'
  )
order by column_name;
