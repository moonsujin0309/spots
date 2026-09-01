-- 스팟스 DB 스키마 (Supabase / PostgreSQL)
-- 2026-09-01
--
-- 설계 원칙
--  1. 프로토타입 index.html 의 PLACES / ROUTES 구조를 최대한 그대로 옮긴다.
--     필드명이 유지되면 앱 코드에서 바꿀 곳이 데이터 소스 한 곳으로 줄어든다.
--  2. 개인위치정보(사용자의 현재 좌표)는 **저장하지 않는다.**
--     저장하는 순간 위치정보법상 위치기반서비스사업 신고 대상이 된다.
--     places.lat/lng 는 장소의 좌표이지 사람의 좌표가 아니다 — 규제 대상이 아니다.
--  3. RLS 를 전 테이블에 건다. 앱 코드 실수로 남의 데이터가 새지 않게 DB가 막는다.
--  4. 카운트(좋아요·저장)는 비정규화해 둔다. 정렬에 매번 count(*) 를 돌리면 목록이 느려진다.

-- ════════════════════════════════════════════════════════════
-- 1. 프로필
-- ════════════════════════════════════════════════════════════
create table profiles (
  id          uuid primary key references auth.users on delete cascade,
  nick        text not null unique check (char_length(nick) between 2 and 20),
  avatar      text,                            -- 이모지 1자 또는 이미지 URL (기존 av 필드)
  bio         text check (char_length(bio) <= 200),
  role        text not null default 'user'
              check (role in ('user','staff','official','admin')),
  -- staff = 지인 알바. 배지를 달되 계정은 각자 따로 둔다.
  -- 전부 하나의 'Official' 계정으로 몰면 팔로우 기능이 죽는다(팔로우할 사람이 하나뿐).
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz                      -- 탈퇴. 하드 삭제 대신 마스킹 (법정 보관 항목 때문)
);

-- ════════════════════════════════════════════════════════════
-- 2. 지역 · 장소
-- ════════════════════════════════════════════════════════════
create table areas (
  id    text primary key,                      -- 'seongsu' 등 기존 키 그대로
  name  text not null,
  lat   double precision not null,
  lng   double precision not null,
  tone  text,                                  -- 폴백 아트 색상 키
  photo_key text,
  seq   int not null default 0
);

create table places (
  id          text primary key,                -- 'onion' 등 기존 키 그대로. 커스텀은 uuid 문자열
  name        text not null,
  cat         text not null,                   -- 카페/식당/공원/전시/복합공간/고궁/시장/골목/술집/서점/액티비티
  area_id     text not null references areas,
  lat         double precision not null,
  lng         double precision not null,
  open_at     time,                            -- null = 영업시간 모름
  close_at    time,
  closed_days smallint[] not null default '{}',-- 0=일 … 6=토 (기존 closed 배열 그대로)
  cost_lo     int not null default 0,          -- 1인 기준 원
  cost_hi     int not null default 0,
  parking     boolean not null default false,
  wait        boolean not null default false,  -- 대기 있는 곳
  popularity  smallint not null default 50,
  photo_key   text,
  outdoor     boolean not null default false,
  kakao_place_id text,                         -- 있으면 카카오 장소 상세로 보낸다
  no_kakao    boolean not null default false,  -- 카카오 검색으로 안 찾아지는 곳(골목·산책로 등)

  created_by  uuid references profiles on delete set null,  -- null = 운영 시드 또는 담은 사람이 탈퇴
  approx      boolean not null default false,  -- 좌표가 대략치 (addQuick 으로 담긴 경우)
  status      text not null default 'active'
              check (status in ('active','pending','closed','hidden')),
  -- pending: 유저가 담았지만 아직 검수 전 / closed: 폐업 확인됨

  -- 유저 제보 기반 갱신의 축. 오래된 순으로 뽑아 알바팀이 돌린다.
  verified_at timestamptz,
  verified_by uuid references profiles on delete set null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on places (area_id);
create index on places (status, verified_at nulls first);   -- 검증 만료 목록
create index on places using gin (to_tsvector('simple', name));

-- ════════════════════════════════════════════════════════════
-- 3. 루트
-- ════════════════════════════════════════════════════════════
create table routes (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references profiles on delete cascade,
  area_id     text not null references areas,
  title       text not null check (char_length(title) between 4 and 40),
  mood        text,                            -- 한 줄 요약
  note        text,                            -- 출발지점·주의사항
  transport   text not null default 'transit'
              check (transport in ('transit','car','walk')),
  people      smallint not null default 2,
  plan        boolean not null default true,   -- true=계획 루트, false=다녀온 루트
  fame        text,                            -- '드라마 촬영지' 등 배지
  ai_assisted boolean not null default false,  -- 기존 ai 플래그. 표시 정책 필요
  /* 인용 원본. 원본이 사라지면(작성자 탈퇴 등) 출처 표시만 없어지고
     인용한 쪽 루트는 자기 route_stops 를 갖고 있어 그대로 산다 */
  via_route_id uuid references routes on delete set null,

  status      text not null default 'public'
              check (status in ('draft','public','private','hidden','deleted')),
  -- hidden = 신고 접수로 임시조치된 상태

  like_count  int not null default 0,          -- 비정규화 (트리거로 갱신)
  save_count  int not null default 0,
  view_count  int not null default 0,

  published_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on routes (area_id, status, published_at desc);
create index on routes (author_id, status);
create index on routes (status, like_count desc);

create table route_stops (
  route_id  uuid not null references routes on delete cascade,
  seq       smallint not null,                 -- 0부터
  place_id  text not null references places,
  stay_min  smallint not null default 60,
  comment   text,                              -- 이 스팟에서 뭘 하는지. 알바 지침상 필수 항목
  primary key (route_id, seq)
);
create index on route_stops (place_id);

/* 스팟 사진 — 스팟당 최대 3장. 파일은 Storage 에 두고 여기엔 경로만 남긴다.
   route_stops 에 컬럼으로 붙이지 않는 이유는 한 스팟에 여러 장이 붙기 때문이다. */
create table route_photos (
  id        uuid primary key default gen_random_uuid(),
  route_id  uuid not null references routes on delete cascade,
  place_id  text not null references places,
  seq       smallint not null default 0,
  path      text not null,                     -- storage 오브젝트 경로
  created_at timestamptz not null default now(),
  unique (route_id, place_id, seq)
);
create index on route_photos (route_id);

-- ════════════════════════════════════════════════════════════
-- 4. 상호작용
-- ════════════════════════════════════════════════════════════
create table place_likes (
  user_id  uuid not null references profiles on delete cascade,
  place_id text not null references places on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, place_id)
);

create table folders (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  name    text not null,
  seq     smallint not null default 0,
  unique (user_id, name)
);
-- 기본 폴더 '가보고 싶어' / '데이트' / '친구랑' 은 가입 시 트리거로 생성

create table route_saves (
  user_id   uuid not null references profiles on delete cascade,
  route_id  uuid not null references routes on delete cascade,
  folder_id uuid references folders on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, route_id)
);

create table follows (
  follower_id uuid not null references profiles on delete cascade,
  followee_id uuid not null references profiles on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);

create table visits (
  user_id    uuid not null references profiles on delete cascade,
  place_id   text not null references places on delete cascade,
  visited_at timestamptz not null default now(),
  primary key (user_id, place_id)
);
-- 주의: 이건 '이 장소에 다녀왔다'는 사용자 입력이지 위치 추적이 아니다.
-- GPS 좌표나 방문 시각의 자동 수집으로 확장하지 말 것 — 위치정보법 대상이 된다.

create table route_memos (
  route_id  uuid not null references routes on delete cascade,
  user_id   uuid not null references profiles on delete cascade,
  place_id  text not null references places on delete cascade,
  body      text not null check (char_length(body) <= 500),
  is_public boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (route_id, user_id, place_id)
);

-- ════════════════════════════════════════════════════════════
-- 5. 댓글
-- ════════════════════════════════════════════════════════════
-- 권장: 런칭 1차에는 이 테이블을 열지 말고 place_reports 만 연다.
-- 자유 댓글은 신고·차단·삭제·검수 화면을 한 세트로 요구한다.
create table comments (
  id        uuid primary key default gen_random_uuid(),
  route_id  uuid not null references routes on delete cascade,
  author_id uuid references profiles on delete set null,  -- null = 탈퇴한 사용자
  parent_id uuid references comments on delete cascade,   -- 대댓글 1단계까지만
  body      text not null check (char_length(body) between 1 and 1000),
  status    text not null default 'visible'
            check (status in ('visible','hidden','deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on comments (route_id, created_at);

-- ════════════════════════════════════════════════════════════
-- 6. 신고 — 두 종류를 섞지 않는다
-- ════════════════════════════════════════════════════════════

-- 6-1. 장소 정보 제보 = 데이터 갱신 파이프라인
create table place_reports (
  id          uuid primary key default gen_random_uuid(),
  place_id    text not null references places on delete cascade,
  reporter_id uuid references profiles on delete set null,  -- 비로그인 제보 또는 탈퇴
  kind        text not null
              check (kind in ('closed','hours','price','location','duplicate','other')),
  body        text check (char_length(body) <= 500),
  suggested   jsonb,                           -- {"open_at":"10:00","close_at":"21:00"} 제안값
  status      text not null default 'open'
              check (status in ('open','accepted','rejected','duplicate')),
  handled_by  uuid references profiles on delete set null,
  handled_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index on place_reports (status, created_at);
create index on place_reports (place_id, status);

-- 6-2. 콘텐츠 신고 = 법적 의무 (정보통신망법 임시조치)
-- 접수 → 확인 → 조치 → 이력 보관이 돌아가야 한다. 버튼만 있는 건 이행이 아니다.
create table content_reports (
  id          uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('route','comment','profile')),
  target_id   text not null,                   -- uuid를 문자열로. 대상 테이블이 셋이라 FK 대신
  reporter_id uuid references profiles on delete set null,   -- 탈퇴해도 신고 기록은 남는다
  reason      text not null
              check (reason in ('spam','abuse','sexual','copyright','false_info','privacy','other')),
  body        text check (char_length(body) <= 1000),
  status      text not null default 'open'
              check (status in ('open','reviewing','actioned','rejected')),
  action      text,                            -- 실제 조치 내용 (숨김/삭제/경고/계정정지)
  handled_by  uuid references profiles on delete set null,
  handled_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index on content_reports (status, created_at);
create index on content_reports (target_type, target_id);

create table blocks (
  blocker_id uuid not null references profiles on delete cascade,
  blocked_id uuid not null references profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

-- ════════════════════════════════════════════════════════════
-- 7. 카운트 트리거 — 정렬용 비정규화 유지
-- ════════════════════════════════════════════════════════════
create or replace function bump_route_saves() returns trigger
language plpgsql security definer as $$
begin
  update routes set save_count = save_count + (case when tg_op='INSERT' then 1 else -1 end)
   where id = coalesce(new.route_id, old.route_id);
  return null;
end $$;

create trigger route_saves_count
  after insert or delete on route_saves
  for each row execute function bump_route_saves();

-- ════════════════════════════════════════════════════════════
-- 8. RLS
-- ════════════════════════════════════════════════════════════
alter table profiles        enable row level security;
alter table areas           enable row level security;
alter table places          enable row level security;
alter table routes          enable row level security;
alter table route_stops     enable row level security;
alter table place_likes     enable row level security;
alter table folders         enable row level security;
alter table route_saves     enable row level security;
alter table follows         enable row level security;
alter table visits          enable row level security;
alter table route_memos     enable row level security;
alter table comments        enable row level security;
alter table place_reports   enable row level security;
alter table content_reports enable row level security;
alter table route_photos    enable row level security;
alter table blocks          enable row level security;

-- 공개 읽기 — 지역·장소·프로필은 누구나
create policy read_areas    on areas    for select using (true);
create policy read_places   on places   for select using (status = 'active');
create policy read_profiles on profiles for select using (deleted_at is null);

-- 루트: 공개된 것 + 내 것 전부
/* 차단한 사람의 루트는 아예 내려오지 않는다.
   클라이언트에서 거르면 이미 받아 온 뒤라 목록 개수가 어긋나고, 링크로는 그대로 열린다. */
create policy read_routes on routes for select
  using ((status = 'public' or author_id = auth.uid())
         and not exists (select 1 from blocks b
                         where b.blocker_id = auth.uid() and b.blocked_id = author_id));
create policy write_routes on routes for all
  using (author_id = auth.uid()) with check (author_id = auth.uid());

create policy read_stops on route_stops for select
  using (exists (select 1 from routes r where r.id = route_id
                 and (r.status = 'public' or r.author_id = auth.uid())));
create policy write_stops on route_stops for all
  using (exists (select 1 from routes r where r.id = route_id and r.author_id = auth.uid()));

create policy read_photos on route_photos for select
  using (exists (select 1 from routes r where r.id = route_id
                 and (r.status = 'public' or r.author_id = auth.uid())));
create policy write_photos on route_photos for all
  using (exists (select 1 from routes r where r.id = route_id and r.author_id = auth.uid()));

-- 개인 데이터: 본인만. 저장함·방문기록·폴더가 남에게 보이면 안 된다.
create policy own_saves   on route_saves for all using (user_id = auth.uid());
create policy own_visits  on visits      for all using (user_id = auth.uid());
create policy own_folders on folders     for all using (user_id = auth.uid());
create policy own_likes   on place_likes for all using (user_id = auth.uid());

-- 좋아요 수는 남도 봐야 하므로 집계는 places.popularity / routes.like_count 로만 노출한다.

-- 팔로우는 공개 (프로필에 팔로잉 수가 뜬다), 쓰기는 본인만
create policy read_follows  on follows for select using (true);
create policy write_follows on follows for all using (follower_id = auth.uid());

-- 메모: 공개 설정된 것 + 내 것
create policy read_memos on route_memos for select
  using (is_public or user_id = auth.uid());
create policy write_memos on route_memos for all using (user_id = auth.uid());

-- 댓글: 보이는 것만. 차단한 사람 건 안 보인다.
create policy read_comments on comments for select
  using (status = 'visible'
         and not exists (select 1 from blocks b
                         where b.blocker_id = auth.uid() and b.blocked_id = author_id));
create policy write_comments on comments for all
  using (author_id = auth.uid()) with check (author_id = auth.uid());

-- 신고: 넣을 수만 있고 남의 신고는 못 본다
create policy insert_place_report on place_reports for insert with check (true);
create policy read_own_place_report on place_reports for select
  using (reporter_id = auth.uid());
create policy insert_content_report on content_reports for insert
  with check (reporter_id = auth.uid());
create policy read_own_content_report on content_reports for select
  using (reporter_id = auth.uid());

create policy own_blocks on blocks for all using (blocker_id = auth.uid());

-- ════════════════════════════════════════════════════════════
-- 9. 회원 탈퇴
-- ════════════════════════════════════════════════════════════
/* 탈퇴는 개인정보 보호법상 필수이고, 되돌릴 수 없다.
   클라이언트가 직접 delete 를 날리게 하면 RLS 로 막을 수 없는 구멍이 생기므로
   함수 하나로만 열어 둔다. SECURITY DEFINER 라 auth.users 까지 지울 수 있다.

   ⚠️ 삭제 순서가 아니라 **외래키의 on delete 규칙**이 실제 동작을 정한다.
      auth.users 를 지우면 profiles 가 cascade 로 지워지고, 그때
        · 내 루트·저장·좋아요·팔로우·방문·메모·폴더·차단 → cascade 로 함께 삭제
        · 내가 담은 장소(created_by), 내 신고 기록(reporter_id), 내 댓글(author_id) → set null
      이 규칙이 없으면 "routes 가 참조 중"이라며 삭제가 통째로 막힌다.

   남이 인용한 내 루트도 지운다. 인용한 쪽 루트는 자기 route_stops 를 갖고 있어
   내용이 깨지지 않고, via_route_id 가 null 이 되면서 출처 표시만 사라진다
   (약관 제5조 3항 — 인용한 부분은 그 회원의 게시물로 남는다). */
create or replace function delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception '로그인 상태가 아닙니다'; end if;

  -- 내가 올린 댓글은 내용을 지우고 자리만 남긴다(스레드가 끊기지 않게).
  -- author_id 는 아래 cascade 에서 null 이 된다.
  update comments set body = '(삭제된 댓글)', status = 'deleted' where author_id = uid;

  -- 여기 한 줄이 나머지 전부를 끌고 간다. 위 주석의 규칙대로 퍼진다.
  delete from auth.users where id = uid;
end $$;

revoke all on function delete_my_account() from public;
grant execute on function delete_my_account() to authenticated;

-- 운영자는 service_role 키로 접근한다(RLS 우회). 관리자 화면은 서버 함수 경유.
-- ⚠️ service_role 키를 클라이언트에 절대 넣지 말 것 — 공개 저장소다.
