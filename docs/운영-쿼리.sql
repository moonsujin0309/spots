-- 스팟스 운영 쿼리집
--
-- 관리자 화면을 따로 만들기 전까지 Supabase 대시보드의 SQL 에디터에서 그대로 돌린다.
-- 대시보드는 service_role 권한으로 실행되므로 RLS 를 통과한다.
-- ⚠️ service_role 키를 앱에 넣어 관리자 화면을 만들지 말 것 — 공개 저장소라 즉시 노출된다.
--    관리자 화면이 필요해지면 Edge Function 뒤에 두고 role='admin' 을 검사한다.

-- ════════════════════════════════════════════════════════════
-- 1. 매일 볼 것 — 제보 큐
-- ════════════════════════════════════════════════════════════

-- 1-1. 미처리 장소 제보 (오래된 순)
select r.id, r.created_at::date 접수일, p.name 장소, a.name 지역,
       case r.kind when 'closed' then '폐업' when 'hours' then '영업시간'
                   when 'price' then '가격' when 'location' then '위치'
                   when 'duplicate' then '중복' else '기타' end 종류,
       r.body 내용, r.suggested 제안값
  from place_reports r
  join places p on p.id = r.place_id
  join areas  a on a.id = p.area_id
 where r.status = 'open'
 order by r.created_at;

-- 1-2. 같은 장소에 제보가 몰린 곳 — 여러 명이 말하면 사실일 가능성이 높다
select p.name 장소, r.kind 종류, count(*) 건수, max(r.created_at)::date 최근
  from place_reports r join places p on p.id = r.place_id
 where r.status = 'open'
 group by p.name, r.kind having count(*) >= 2
 order by count(*) desc;

-- ════════════════════════════════════════════════════════════
-- 2. 제보 반영
-- ════════════════════════════════════════════════════════════

-- 2-1. 폐업 확인 → 장소를 내린다. 그 장소가 든 루트도 같이 확인해야 한다.
--      (:place_id 자리에 실제 값을 넣는다)
update places set status = 'closed', verified_at = now() where id = :place_id;

-- 폐업 장소가 든 루트 — 스팟이 3개 이하로 줄면 루트가 성립하지 않는다
select r.id, r.title, p2.nick 작성자,
       (select count(*) from route_stops s2 join places pp on pp.id = s2.place_id
         where s2.route_id = r.id and pp.status = 'active') 남는스팟
  from routes r
  join profiles p2 on p2.id = r.author_id
 where r.status = 'public'
   and exists (select 1 from route_stops s where s.route_id = r.id and s.place_id = :place_id)
 order by 4;

-- 2-2. 영업시간 정정
update places set open_at = :open, close_at = :close, verified_at = now() where id = :place_id;

-- 2-3. 가격 정정
update places set cost_lo = :lo, cost_hi = :hi, verified_at = now() where id = :place_id;

-- 2-4. 제보 처리 완료 표시 — 반영했으면 accepted, 사실이 아니면 rejected
update place_reports
   set status = 'accepted', handled_by = :admin_id, handled_at = now()
 where id = :report_id;

-- ════════════════════════════════════════════════════════════
-- 3. 검증 만료 — 알바팀 작업 목록
-- ════════════════════════════════════════════════════════════

-- 3-1. 6개월 넘게 확인 안 한 장소. 카페는 6개월이면 절반이 바뀐다.
--      틀린 영업시간으로 헛걸음한 사용자는 그 자리에서 이탈한다.
select p.id, p.name 장소, a.name 지역, p.cat 종류,
       coalesce(p.verified_at::date::text, '한 번도 없음') 마지막확인,
       count(distinct s.route_id) 이장소를쓰는루트
  from places p
  join areas a on a.id = p.area_id
  left join route_stops s on s.place_id = p.id
 where p.status = 'active'
   and (p.verified_at is null or p.verified_at < now() - interval '6 months')
 group by p.id, p.name, a.name, p.cat, p.verified_at
 order by count(distinct s.route_id) desc, p.verified_at nulls first;
-- 루트에 많이 쓰인 장소부터 확인한다 — 틀렸을 때 피해가 가장 크다

-- 3-2. 유저가 담은 미검수 장소
select p.id, p.name, a.name 지역, pr.nick 담은사람, p.created_at::date, p.approx 좌표대략
  from places p join areas a on a.id = p.area_id
  left join profiles pr on pr.id = p.created_by
 where p.status = 'pending' order by p.created_at;

-- ════════════════════════════════════════════════════════════
-- 4. 콘텐츠 신고 — 법적 의무. 접수·처리 이력이 남아야 한다.
-- ════════════════════════════════════════════════════════════

-- 4-1. 미처리 신고
select cr.id, cr.created_at 접수, cr.target_type 대상, cr.target_id,
       cr.reason 사유, cr.body 내용, pr.nick 신고자,
       case cr.target_type when 'route'
            then (select title from routes where id::text = cr.target_id)
            when 'comment'
            then (select left(body,40) from comments where id::text = cr.target_id) end 대상내용
  from content_reports cr
  left join profiles pr on pr.id = cr.reporter_id
 where cr.status = 'open' order by cr.created_at;

-- 4-2. 임시조치 — 확인 전에 일단 가린다.
--      정보통신망법 제44조의2에 따라 최장 30일. 반드시 처리 이력을 남긴다.
update routes set status = 'hidden' where id = :route_id;
update content_reports
   set status = 'actioned', action = '임시조치(30일)', handled_by = :admin_id, handled_at = now()
 where id = :report_id;

-- 4-3. 신고가 근거 없을 때
update content_reports
   set status = 'rejected', action = '위반 없음', handled_by = :admin_id, handled_at = now()
 where id = :report_id;

-- 4-4. 처리가 늦어지는 신고 — 3일 넘게 방치된 것
select id, created_at, target_type, reason,
       now()::date - created_at::date as 경과일
  from content_reports
 where status in ('open','reviewing') and created_at < now() - interval '3 days'
 order by created_at;

-- ════════════════════════════════════════════════════════════
-- 5. 현황
-- ════════════════════════════════════════════════════════════

-- 5-1. 지역별 루트 수 — 비어 있는 지역이 신규 작성 우선순위다
--      ⚠️ routes 와 places 를 한꺼번에 join 하면 안 된다. 두 갈래가 곱해져
--         루트 4개 × 장소 5개 = 20 처럼 숫자가 부풀려진다. 세는 것이 둘이면 각각 센다.
select a.name 지역,
       (select count(*) from routes r where r.area_id = a.id and r.status = 'public') 공개루트,
       (select count(*) from places p where p.area_id = a.id and p.status = 'active') 장소
  from areas a
 order by 2, 3;

-- 5-2. 작성자별 기여
select pr.nick 작성자, pr.role 구분, count(r.*) 루트,
       coalesce(sum(r.save_count),0) 저장, coalesce(sum(r.like_count),0) 좋아요
  from profiles pr left join routes r on r.author_id = pr.id and r.status = 'public'
 group by pr.nick, pr.role order by count(r.*) desc;

-- 5-3. 아무도 저장하지 않은 루트 — 제목이나 첫 사진이 문제일 수 있다
select r.title, a.name 지역, pr.nick 작성자, r.published_at::date 게시일
  from routes r join areas a on a.id = r.area_id join profiles pr on pr.id = r.author_id
 where r.status = 'public' and r.save_count = 0
   and r.published_at < now() - interval '14 days'
 order by r.published_at;

-- 5-4. 루트에 한 번도 안 쓰인 장소 — 데이터만 있고 쓸모가 없는 상태
select p.name, a.name 지역, p.cat
  from places p join areas a on a.id = p.area_id
  left join route_stops s on s.place_id = p.id
 where p.status = 'active' and s.route_id is null
 order by a.name, p.name;
