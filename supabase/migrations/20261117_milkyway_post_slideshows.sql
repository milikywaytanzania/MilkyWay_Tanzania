-- Optional slideshow and soundtrack metadata for posts. Existing single-media posts remain unchanged.
begin;

alter table public.mw_posts
  add column if not exists media_items jsonb not null default '[]'::jsonb,
  add column if not exists audio_url text,
  add column if not exists slideshow_style text not null default 'fade';

alter table public.mw_posts
  drop constraint if exists mw_posts_slideshow_style_check;
alter table public.mw_posts
  add constraint mw_posts_slideshow_style_check
  check (slideshow_style in ('fade', 'zoom', 'cinema'));

commit;
notify pgrst, 'reload schema';
