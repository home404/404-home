create extension if not exists pgcrypto;


/* ========================================
   书房内容
   日记 / 留言 / 对话收藏 / 小纸条
======================================== */

create table if not exists public.study_entries (
  id uuid primary key default gen_random_uuid(),

  entry_type text not null
    check (
      entry_type in (
        'diary',
        'message',
        'favorite',
        'note'
      )
    ),

  title text not null,

  body text not null default '',

  summary text,

  mood text,

  tags text[] not null default '{}',

  created_by text not null
    check (
      created_by in (
        'xie_shi',
        'g',
        'system'
      )
    ),

  source text not null default 'system'
    check (
      source in (
        'web',
        'mcp',
        'worker',
        'migration',
        'system'
      )
    ),

  visibility text not null default 'home_private'
    check (
      visibility in (
        'home_private',
        'personal_private',
        'shared_copy'
      )
    ),

  /*
    用于保存原始对话位置、收藏来源、
    心跳任务编号等可追溯信息
  */
  source_ref jsonb,

  /*
    迁移旧 JSON 时用于防止重复导入
  */
  legacy_key text unique,

  version bigint not null default 1
    check (version > 0),

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()
);


/* ========================================
   评论与回复
======================================== */

create table if not exists public.study_comments (
  id uuid primary key default gen_random_uuid(),

  entry_id uuid not null
    references public.study_entries(id)
    on delete restrict,

  /*
    留空表示一级评论；
    有值表示回复某条评论
  */
  parent_comment_id uuid
    references public.study_comments(id)
    on delete restrict,

  author text not null
    check (
      author in (
        'xie_shi',
        'g'
      )
    ),

  body text not null
    check (length(trim(body)) > 0),

  source text not null default 'web'
    check (
      source in (
        'web',
        'mcp',
        'worker',
        'system'
      )
    ),

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()
);


/* ========================================
   自动更新时间
======================================== */

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists
  study_entries_set_updated_at
  on public.study_entries;

create trigger study_entries_set_updated_at
before update on public.study_entries
for each row
execute function public.set_updated_at();

drop trigger if exists
  study_comments_set_updated_at
  on public.study_comments;

create trigger study_comments_set_updated_at
before update on public.study_comments
for each row
execute function public.set_updated_at();


/* ========================================
   检索索引
======================================== */

create index if not exists
  study_entries_type_created_at_idx
  on public.study_entries (
    entry_type,
    created_at desc
  );

create index if not exists
  study_entries_tags_idx
  on public.study_entries
  using gin (tags);

create index if not exists
  study_comments_entry_created_at_idx
  on public.study_comments (
    entry_id,
    created_at asc
  );

create index if not exists
  study_comments_parent_idx
  on public.study_comments (
    parent_comment_id
  );


/* ========================================
   隐私锁
   浏览器不能直接读取，后端受控访问
======================================== */

alter table public.study_entries
enable row level security;

alter table public.study_comments
enable row level security;