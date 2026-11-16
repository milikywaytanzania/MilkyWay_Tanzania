-- Optional slideshow and soundtrack metadata for posts. Existing single-media posts remain unchanged.
begin;

alter table public.mw_posts
  add column if not exists media_items jsonb not null default '[]'::jsonb,
  add column if not exists audio_url text,
  add column if not exists slideshow_style text not null default 'fade';

update public.mw_posts
set media_items = '[]'::jsonb
where media_items is null;

update public.mw_posts
set slideshow_style = 'fade'
where slideshow_style is null
   or slideshow_style not in ('fade', 'zoom', 'cinema');

alter table public.mw_posts
  alter column media_items set default '[]'::jsonb,
  alter column media_items set not null,
  alter column slideshow_style set default 'fade',
  alter column slideshow_style set not null;

alter table public.mw_posts
  drop constraint if exists mw_posts_slideshow_style_check;

alter table public.mw_posts
  add constraint mw_posts_slideshow_style_check
  check (slideshow_style in ('fade', 'zoom', 'cinema')) not valid;

alter table public.mw_posts
  validate constraint mw_posts_slideshow_style_check;

commit;
notify pgrst, 'reload schema';
