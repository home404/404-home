/* ========================================
   正式写入地基
   用户归属 / 防重复 / 审计日志
======================================== */


/* ----------------------------------------
   书房内容：归属用户与防重复键
---------------------------------------- */

alter table public.study_entries
  add column if not exists owner_user_id uuid
    references auth.users(id)
    on delete set null,

  add column if not exists idempotency_key text;


/* ----------------------------------------
   评论：归属用户与防重复键
---------------------------------------- */

alter table public.study_comments
  add column if not exists owner_user_id uuid
    references auth.users(id)
    on delete set null,

  add column if not exists idempotency_key text;


/* ----------------------------------------
   防止 MCP 重试造成重复写入
---------------------------------------- */

create unique index if not exists
  study_entries_idempotency_key_idx
  on public.study_entries (idempotency_key)
  where idempotency_key is not null;

create unique index if not exists
  study_comments_idempotency_key_idx
  on public.study_comments (idempotency_key)
  where idempotency_key is not null;


/* ========================================
   写入审计日志
======================================== */

create table if not exists public.study_audit_log (
  id uuid primary key default gen_random_uuid(),

  action text not null
    check (
      action in (
        'create_entry',
        'update_entry',
        'delete_entry',
        'create_comment',
        'update_comment',
        'delete_comment'
      )
    ),

  target_type text not null
    check (
      target_type in (
        'study_entry',
        'study_comment'
      )
    ),

  target_id uuid,

  actor_user_id uuid
    references auth.users(id)
    on delete set null,

  actor text not null
    check (
      actor in (
        'xie_shi',
        'g',
        'system'
      )
    ),

  source text not null
    check (
      source in (
        'web',
        'mcp',
        'worker',
        'migration',
        'system'
      )
    ),

  request_id text,

  idempotency_key text,

  success boolean not null,

  error_code text,

  details jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);


/* ----------------------------------------
   审计查询索引
---------------------------------------- */

create index if not exists
  study_audit_log_created_at_idx
  on public.study_audit_log (
    created_at desc
  );

create index if not exists
  study_audit_log_target_idx
  on public.study_audit_log (
    target_type,
    target_id
  );

create index if not exists
  study_audit_log_actor_idx
  on public.study_audit_log (
    actor_user_id,
    created_at desc
  );

create index if not exists
  study_audit_log_request_idx
  on public.study_audit_log (
    request_id
  );


/* ========================================
   隐私默认关闭
   没有明确授权策略时，客户端不可直接读取
======================================== */

alter table public.study_audit_log
enable row level security;