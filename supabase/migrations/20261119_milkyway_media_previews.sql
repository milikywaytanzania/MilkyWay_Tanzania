-- Store small feed/profile renditions separately from full-resolution post media.
begin;

alter table public.mw_posts
  add column if not exists media_preview_items jsonb not null default '[]'::jsonb;

update public.mw_posts
set media_preview_items = '[]'::jsonb
where media_preview_items is null
   or jsonb_typeof(media_preview_items) <> 'array';

alter table public.mw_posts
  alter column media_preview_items set default '[]'::jsonb,
  alter column media_preview_items set not null;

commit;
notify pgrst, 'reload schema';
