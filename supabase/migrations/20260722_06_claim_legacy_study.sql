/* ========================================
   旧书房内容领取房契
   仅适用于 404 小窝当前的单住户阶段
======================================== */

begin;

do $$
declare
  home_user_id uuid;
  home_user_count integer;
begin
  select count(*)
  into home_user_count
  from auth.users;

  if home_user_count <> 1 then
    raise exception
      'Expected exactly one 404 home user, found %',
      home_user_count;
  end if;

  select id
  into home_user_id
  from auth.users
  order by created_at asc
  limit 1;


  /* 十篇旧日记归到屋主名下 */

  update public.study_entries
  set owner_user_id = home_user_id
  where owner_user_id is null;


  /* 已有评论也一并补上归属 */

  update public.study_comments
  set owner_user_id = home_user_id
  where owner_user_id is null;

end
$$;

commit;