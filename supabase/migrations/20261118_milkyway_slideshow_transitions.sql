-- Add lightweight transition choices for photo slideshows.
begin;

alter table public.mw_posts
  add column if not exists slideshow_style text not null default 'fade';

update public.mw_posts
set slideshow_style = 'fade'
where slideshow_style is null
   or slideshow_style not in ('fade', 'zoom', 'cinema', 'page', 'slide');

alter table public.mw_posts
  alter column slideshow_style set default 'fade',
  alter column slideshow_style set not null;

alter table public.mw_posts
  drop constraint if exists mw_posts_slideshow_style_check;

alter table public.mw_posts
  add constraint mw_posts_slideshow_style_check
  check (slideshow_style in ('fade', 'zoom', 'cinema', 'page', 'slide')) not valid;

alter table public.mw_posts
  validate constraint mw_posts_slideshow_style_check;

commit;
notify pgrst, 'reload schema';
