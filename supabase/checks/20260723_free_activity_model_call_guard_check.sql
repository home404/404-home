select
  to_regprocedure(
    'public.enforce_free_activity_model_call_budget()'
  ) is not null as model_call_guard_function_exists;


select exists (
  select 1
  from pg_trigger trigger_row
  join pg_class table_row
    on table_row.oid = trigger_row.tgrelid
  join pg_namespace namespace_row
    on namespace_row.oid = table_row.relnamespace
  where namespace_row.nspname = 'public'
    and table_row.relname = 'activity_runs'
    and trigger_row.tgname =
      'activity_runs_enforce_model_call_budget'
    and not trigger_row.tgisinternal
) as model_call_guard_trigger_exists;


select
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'activity_passes'
  and column_name = 'max_model_calls';
