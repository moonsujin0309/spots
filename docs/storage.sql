-- 스팟스 Storage 설정 (Supabase 전용)
--
-- schema.sql 과 분리한 이유: storage 스키마는 Supabase 가 만들어 두는 것이라
-- 일반 PostgreSQL 에서는 이 파일이 돌지 않는다. 로컬 검증 대상이 아니다.
-- Supabase 대시보드의 SQL 에디터에서 schema.sql 다음에 한 번 실행한다.

-- ── 버킷 ──
-- public = true: 사진 URL 을 그대로 <img src> 에 쓴다.
--   비공개로 두면 볼 때마다 서명 URL 을 받아와야 하고, 목록 화면에서 사진 수십 장이면
--   그만큼 왕복이 늘어난다. 루트 사진은 어차피 공개 게시물에 붙는 것이라 숨길 것이 없다.
-- file_size_limit 5MB: 앱이 올리기 전에 긴 변 1080px 로 줄이므로 보통 200~400KB 다.
--   이 한도는 앱을 거치지 않고 직접 던지는 요청을 막는 마지막 방어선이다.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('route-photos', 'route-photos', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── 정책 ──
-- 경로 규칙: {user_id}/{route_id}/{place_id}-{seq}.jpg
-- 첫 칸이 올린 사람의 uuid 다. 이걸로 "남의 폴더에 못 쓴다"를 강제한다.

drop policy if exists "route photos are public" on storage.objects;
create policy "route photos are public" on storage.objects
  for select using (bucket_id = 'route-photos');

drop policy if exists "upload to own folder" on storage.objects;
create policy "upload to own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'route-photos'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "update own photos" on storage.objects;
create policy "update own photos" on storage.objects
  for update to authenticated
  using (bucket_id = 'route-photos'
         and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "delete own photos" on storage.objects;
create policy "delete own photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'route-photos'
         and (storage.foldername(name))[1] = auth.uid()::text);

-- ⚠️ 탈퇴·루트 삭제 시 Storage 파일은 자동으로 지워지지 않는다.
--    route_photos 행은 cascade 로 사라지지만 파일은 남는다.
--    당장은 용량이 작아 문제가 없으나, 쌓이면 아래처럼 고아 파일을 찾아 지운다.
--
-- select o.name
--   from storage.objects o
--   left join route_photos rp on rp.path = o.name
--  where o.bucket_id = 'route-photos' and rp.id is null;
