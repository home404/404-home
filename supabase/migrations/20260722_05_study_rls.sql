/* ========================================
   404 书房正式门锁 v1
   - 匿名访客：无权访问
   - 登录用户：只能读写自己的内容
   - 审计日志：用户只读，服务器负责写入
======================================== */

begin;


/* ========================================
   确保 RLS 已启用
======================================== */

alter table public.study_entries
enable row level security;

alter table public.study_comments
enable row level security;

alter table public.study_audit_log
enable row level security;


/* ========================================
   清理默认权限
======================================== */

revoke all
on table public.study_entries
from anon;

revoke all
on table public.study_comments
from anon;

revoke all
on table public.study_audit_log
from anon;


revoke all
on table public.study_entries
from authenticated;

revoke all
on table public.study_comments
from authenticated;

revoke all
on table public.study_audit_log
from authenticated;


/* ========================================
   v1 最小权限
   目前只开放读取与新建
   暂不开放修改和删除
======================================== */

grant select, insert
on table public.study_entries
to authenticated;

grant select, insert
on table public.study_comments
to authenticated;

grant select
on table public.study_audit_log
to authenticated;


/* ========================================
   删除同名旧策略，保证迁移可重复执行
======================================== */

drop policy if exists
  "study_entries_select_own"
on public.study_entries;

drop policy if exists
  "study_entries_insert_own"
on public.study_entries;

drop policy if exists
  "study_comments_select_own"
on public.study_comments;

drop policy if exists
  "study_comments_insert_own"
on public.study_comments;

drop policy if exists
  "study_audit_log_select_own"
on public.study_audit_log;


/* ========================================
   书房内容：只能读取自己的内容
======================================== */

create policy
  "study_entries_select_own"

on public.study_entries
for select
to authenticated

using (
  owner_user_id = (
    select auth.uid()
  )
);


/* ========================================
   书房内容：只能写入自己的名下
======================================== */

create policy
  "study_entries_insert_own"

on public.study_entries
for insert
to authenticated

with check (
  owner_user_id = (
    select auth.uid()
  )
);


/* ========================================
   评论：只能读取自己书房里的评论
======================================== */

create policy
  "study_comments_select_own"

on public.study_comments
for select
to authenticated

using (
  owner_user_id = (
    select auth.uid()
  )

  and exists (
    select 1

    from public.study_entries as entry

    where entry.id =
      study_comments.entry_id

      and entry.owner_user_id = (
        select auth.uid()
      )
  )
);


/* ========================================
   评论：只能写进自己的书房内容
======================================== */

create policy
  "study_comments_insert_own"

on public.study_comments
for insert
to authenticated

with check (
  owner_user_id = (
    select auth.uid()
  )

  and author in (
    'xie_shi',
    'g'
  )

  and exists (
    select 1

    from public.study_entries as entry

    where entry.id =
      study_comments.entry_id

      and entry.owner_user_id = (
        select auth.uid()
      )
  )
);


/* ========================================
   审计日志：登录用户只能查看自己的记录
   不授予客户端写入权限
======================================== */

create policy
  "study_audit_log_select_own"

on public.study_audit_log
for select
to authenticated

using (
  actor_user_id = (
    select auth.uid()
  )
);


commit;