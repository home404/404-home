begin;

update public.study_entries
set created_at =
  (
    (source_ref ->> 'legacy_date')::date::timestamp
    at time zone 'Asia/Shanghai'
  )
  +
  make_interval(
    secs => greatest(
      coalesce(
        (source_ref ->> 'legacy_order')::integer,
        0
      ),
      0
    )
  )
where legacy_key like 'diary-json-%'
  and source_ref ? 'legacy_date'
  and source_ref ->> 'legacy_date'
      ~ '^\d{4}-\d{2}-\d{2}$';

commit;