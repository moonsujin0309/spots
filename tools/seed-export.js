#!/usr/bin/env node
/* 시드 데이터 추출 — index.html 에 하드코딩된 AREAS/PLACES/ROUTES 를 schema.sql 용 INSERT 로 뽑는다.
 *
 * 왜 이런 방식인가
 *   데이터가 JS 객체 리터럴로 앱 코드 안에 박혀 있다. 손으로 옮기면 191개 장소 × 15개 필드에서
 *   반드시 오타가 난다. 앱이 읽는 그 값을 그대로 평가해서 뽑는 게 유일하게 안전한 경로다.
 *
 * 사용법
 *   node tools/seed-export.js                        → docs/seed.sql
 *   node tools/seed-export.js --official <uuid>      → 작성자 UUID를 박아서 출력
 *
 * --official 을 안 주면 작성자 자리에 '@OFFICIAL_ID@' 가 들어간다.
 * Supabase 에서 공식 계정을 만든 뒤 그 UUID 로 치환할 것.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

/* ── 선언 하나를 통째로 잘라낸다.
      데이터 안에 괄호가 든 문자열("성수역 3번 출구(도보 6분)")이 있어서
      단순 정규식으로는 끝을 못 찾는다. 문자열·주석을 인식하며 괄호 깊이를 센다. ── */
function slice(name, open, close) {
  const head = `const ${name}=${open}`;
  const at = html.indexOf(head);
  if (at < 0) throw new Error(`${name} 선언을 못 찾았습니다`);
  let i = at + head.length, depth = 1;
  let str = null, esc = false, line = false, block = false;
  while (i < html.length && depth > 0) {
    const c = html[i], n = html[i + 1];
    if (line)       { if (c === "\n") line = false; }
    else if (block) { if (c === "*" && n === "/") { block = false; i++; } }
    else if (str)   { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === str) str = null; }
    else if (c === "/" && n === "/") { line = true; i++; }
    else if (c === "/" && n === "*")  { block = true; i++; }
    else if (c === '"' || c === "'" || c === "`") str = c;
    else if (c === open)  depth++;
    else if (c === close) depth--;
    i++;
  }
  if (depth !== 0) throw new Error(`${name} 의 끝을 못 찾았습니다`);
  return html.slice(at + `const ${name}=`.length, i);
}

/* 괄호로 감싸서 평가한다 — 감싸지 않으면 { … } 가 객체가 아니라 블록문으로 읽힌다 */
const val = src => eval("(" + src + ")");
const AREAS  = val(slice("AREAS",  "[", "]"));
const PLACES = val(slice("PLACES", "{", "}"));
const ROUTES = val(slice("ROUTES", "[", "]"));
const POSTED = val(slice("POSTED_BATCH", "{", "}"));

const OFFICIAL = (() => {
  const i = process.argv.indexOf("--official");
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : "@OFFICIAL_ID@";
})();

/* ── SQL 리터럴 ── */
const q = v => v == null || v === "" ? "null" : `'${String(v).replace(/'/g, "''")}'`;
const n = v => (v == null || v === "" ? "null" : Number(v));
const b = v => (v ? "true" : "false");
const arr = a => (!a || !a.length ? "'{}'" : `'{${a.join(",")}}'`);
const time = t => (!t ? "null" : `'${t}'`);
/* 00:00~23:59 는 '영업시간 정보 없음'을 뜻하는 관용 표기다. null 로 옮긴다 —
   schema 에서 null 이 '모름'이고, 23:59 를 그대로 두면 자정까지 여는 곳으로 계산된다. */
const openOf  = p => (p.open === "00:00" && p.close === "23:59" ? null : p.open);
const closeOf = p => (p.open === "00:00" && p.close === "23:59" ? null : p.close);

const out = [];
out.push(`-- 스팟스 시드 데이터 — tools/seed-export.js 자동 생성 (${new Date().toISOString().slice(0, 10)})`);
out.push(`-- 지역 ${AREAS.length} · 장소 ${Object.keys(PLACES).length} · 루트 ${ROUTES.length}`);
out.push(`-- 손으로 고치지 말 것. index.html 을 고치고 스크립트를 다시 돌린다.`);
if (OFFICIAL === "@OFFICIAL_ID@")
  out.push(`--\n-- ⚠️ 작성자 자리가 '@OFFICIAL_ID@' 입니다. 공식 계정 UUID 로 치환한 뒤 실행하세요.\n--    node tools/seed-export.js --official <uuid> 로 다시 뽑아도 됩니다.`);
out.push("", "begin;", "");

/* ── 지역 ── */
out.push("-- 지역");
AREAS.forEach((a, i) => out.push(
  `insert into areas (id,name,lat,lng,tone,photo_key,seq) values ` +
  `(${q(a.id)},${q(a.n)},${a.lat},${a.lng},${q(a.tone)},${q(a.img)},${i}) on conflict (id) do nothing;`
));
out.push("");

/* ── 장소 ── */
out.push("-- 장소");
for (const [key, p] of Object.entries(PLACES)) {
  out.push(
    `insert into places (id,name,cat,area_id,lat,lng,open_at,close_at,closed_days,` +
    `cost_lo,cost_hi,parking,wait,popularity,photo_key,outdoor,kakao_place_id,no_kakao,verified_at) values (` +
    `${q(key)},${q(p.n)},${q(p.c)},${q(p.area)},${p.lat},${p.lng},` +
    `${time(openOf(p))},${time(closeOf(p))},${arr(p.closed)},` +
    `${n(p.cost && p.cost[0]) || 0},${n(p.cost && p.cost[1]) || 0},` +
    `${b(p.park)},${b(p.wait)},${n(p.pop) || 50},${q(p.img)},${b(p.out)},` +
    `${q(p.kid)},${b(p.nokakao)},now()) on conflict (id) do nothing;`
  );
}
out.push("");

/* ── 루트 + 스팟 ──
   기존 id('s1','y2'…)는 uuid 가 아니라서 그대로 못 쓴다.
   대신 결정론적으로 uuid 를 만든다(같은 입력 → 같은 uuid). 재실행해도 중복이 안 생기고
   route_stops 가 참조할 id 를 미리 알 수 있다. */
const { createHash } = require("crypto");
const uuidOf = seed => {
  const h = createHash("sha1").update("spots:" + seed).digest("hex");
  return [h.slice(0,8), h.slice(8,12), "5"+h.slice(13,16),
          ((parseInt(h[16],16) & 0x3 | 0x8).toString(16)) + h.slice(17,20), h.slice(20,32)].join("-");
};

out.push("-- 루트");
for (const r of ROUTES) {
  const id = uuidOf(r.id);
  const posted = POSTED[r.id] ? POSTED[r.id].replace(/\./g, "-") : null;
  out.push(
    `insert into routes (id,author_id,area_id,title,mood,note,transport,people,plan,fame,` +
    `ai_assisted,status,like_count,published_at) values (` +
    `'${id}',${OFFICIAL === "@OFFICIAL_ID@" ? `'@OFFICIAL_ID@'` : `'${OFFICIAL}'`},${q(r.area)},` +
    `${q(r.title)},${q(r.mood)},${q(r.note)},${q(r.transport)},${n(r.people) || 2},` +
    `${b(r.plan)},${q(r.fame)},${b(r.ai)},'public',${n(r.likes) || 0},` +
    `${posted ? `'${posted}'` : "now()"}) on conflict (id) do nothing;`
  );
  r.stops.forEach((s, i) => out.push(
    `insert into route_stops (route_id,seq,place_id,stay_min,comment) values ` +
    `('${id}',${i},${q(s.p)},${n(s.stay) || 60},${q(s.c)}) on conflict do nothing;`
  ));
}
out.push("", "commit;");

/* ── 검증 — 루트가 가리키는 장소가 전부 PLACES 에 있는지 ── */
const missing = new Set();
ROUTES.forEach(r => r.stops.forEach(s => { if (!PLACES[s.p]) missing.add(s.p); }));
const badArea = Object.entries(PLACES)
  .filter(([, p]) => !AREAS.some(a => a.id === p.area))
  .map(([k, p]) => `${k}(${p.area})`);

const dest = path.join(ROOT, "docs", "seed.sql");
fs.writeFileSync(dest, out.join("\n") + "\n");

console.log(`지역 ${AREAS.length} · 장소 ${Object.keys(PLACES).length} · 루트 ${ROUTES.length} ` +
            `· 스팟 ${ROUTES.reduce((a, r) => a + r.stops.length, 0)}`);
console.log(`→ ${path.relative(ROOT, dest)} (${out.length}줄)`);
if (missing.size) { console.error(`\n⚠️ PLACES 에 없는 장소를 가리키는 루트: ${[...missing].join(", ")}`); process.exitCode = 1; }
if (badArea.length) { console.error(`\n⚠️ AREAS 에 없는 지역을 가리키는 장소: ${badArea.join(", ")}`); process.exitCode = 1; }
if (!missing.size && !badArea.length) console.log("참조 무결성 확인 — 깨진 곳 없음");
