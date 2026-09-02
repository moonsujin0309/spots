#!/usr/bin/env node
/* 루트 제출물 검수 · SQL 변환
 *
 * 알바 작성자가 낸 CSV 를 지침서(docs/루트-작성-지침서.md) 기준으로 자동 검수하고,
 * 통과한 것만 INSERT 문으로 뽑는다.
 *
 * 기계가 판단할 수 있는 것만 본다 — 스팟 수·체류시간·길이·필수항목·상투어·이동거리.
 * "실제로 가봤는가"는 판단하지 못한다. 그건 사람이 본다.
 *
 * 사용법
 *   node tools/route-import.js 제출물.csv
 *   node tools/route-import.js 제출물.csv --author <uuid> --out docs/new-routes.sql
 *
 * 종료 코드 1 = 반려 항목이 하나라도 있음
 */
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

const ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith("--"));
const opt = k => { const i = argv.indexOf("--" + k); return i > 0 ? argv[i + 1] : null; };
if (!file) { console.error("사용법: node tools/route-import.js <제출물.csv> [--author <uuid>] [--out <파일>]"); process.exit(2); }

const AUTHOR = opt("author") || "@AUTHOR_ID@";
const OUT = opt("out") || path.join(ROOT, "docs", "new-routes.sql");

/* ── CSV — 따옴표 안의 쉼표와 줄바꿈을 지킨다 ── */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift().map(h => h.trim());
  return rows.filter(r => r.some(c => c.trim()))
             .map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

/* ── 기존 장소를 index.html 에서 읽어 온다 — place_id 만 쓴 행의 좌표를 채우기 위해 ── */
function loadPlaces() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const head = "const PLACES={";
  const at = html.indexOf(head);
  let i = at + head.length, depth = 1, str = null, esc = false, line = false, block = false;
  while (i < html.length && depth > 0) {
    const c = html[i], nx = html[i + 1];
    if (line)       { if (c === "\n") line = false; }
    else if (block) { if (c === "*" && nx === "/") { block = false; i++; } }
    else if (str)   { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === str) str = null; }
    else if (c === "/" && nx === "/") { line = true; i++; }
    else if (c === "/" && nx === "*") { block = true; i++; }
    else if (c === '"' || c === "'" || c === "`") str = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  return eval("(" + html.slice(at + "const PLACES=".length, i) + ")");
}
const PLACES = loadPlaces();

/* ── 검수 규칙 ── */
/* 수치는 시드 136개 실측 분포에서 뽑았다. 임의로 정하면 실제 콘텐츠를 반려한다.
   실측: 스팟 4개 120 / 5개 16 · 총 체류 중앙 280분(215~430) · 코멘트 중앙 38자(7~70) */
const STOPS_MIN = 4, STOPS_MAX = 5;
const STAY_MIN = 200, STAY_MAX = 360;          // 반려 경계. 360~420은 경고만
const STAY_WARN = 420;
/* 상한은 앱의 입력 제한(index.html 의 TITLE_MAX)과 같은 값이어야 한다 —
   더 길게 잡으면 앱에서 입력조차 못 하는 제목을 통과시킨다.
   하한은 앱(2자)보다 높다. 두 글자짜리 제목은 통과시킬 이유가 없다. */
const TITLE_MIN = 4, TITLE_MAX = 25;
const CMT_MIN = 20, CMT_MAX = 80;              // 하한은 시드보다 높다 — 7자짜리 코멘트가 실제로 부실했다

/* 구간 거리 — '도보 몇 분'이 아니라 거리로 본다.
   앱의 leg()가 거리로 이동수단을 자동 배정하기 때문이다(1.2km↓ 도보 / 3km↓ 버스 / 7km↓ 지하철 / 그 이상 혼합).
   즉 이 서비스는 애초에 대중교통 구간을 전제로 설계돼 있다. 실측도 46%가 1.2km를 넘는다.
   7km를 넘으면 '혼합'으로 떨어져 환승이 끼고, 하루 안에 4~5곳을 도는 리듬이 무너진다. */
const LEG_MAX_M = 7000;                         // 반려
const LEG_WARN_M = 3000;                        // 지하철 구간 — 경고
const DETOUR = 1.3;                             // 직선 → 실제 보정 (앱 leg() 와 같은 값)

/* 다른 곳에 붙여도 말이 되는 문장을 잡는다. 지침서 2절의 '반려 대상' 예시에서 뽑았다. */
const CLICHE = [
  "분위기가 좋", "분위기 좋", "데이트하기 좋", "데이트 하기 좋", "인생샷", "감성", "낭만",
  "핫플", "힐링", "맛집", "꼭 가봐야", "강추", "최고예요", "만족스러", "추천드",
  "좋은 곳이", "좋은 장소", "볼거리가 많", "먹거리가 많", "다양한 음식",
];

function haversine(a, b) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const rows = parseCsv(fs.readFileSync(file, "utf8"));
const groups = new Map();
for (const r of rows) {
  if (!r.route_key) continue;
  if (!groups.has(r.route_key)) groups.set(r.route_key, []);
  groups.get(r.route_key).push(r);
}

const uuidOf = seed => {
  const h = createHash("sha1").update("spots:" + seed).digest("hex");
  return [h.slice(0,8), h.slice(8,12), "5"+h.slice(13,16),
          ((parseInt(h[16],16) & 0x3 | 0x8).toString(16)) + h.slice(17,20), h.slice(20,32)].join("-");
};

const passed = [], report = [];
for (const [key, raw] of groups) {
  const stops = raw.slice().sort((a, b) => (+a.seq || 0) - (+b.seq || 0));
  const head = stops[0];
  const err = [], warn = [];

  /* 좌표 해결 — place_id 가 기존 장소면 거기서, 새 장소면 CSV 의 lat/lng 에서 */
  const pts = stops.map(s => {
    const known = PLACES[s.place_id];
    if (known) return { lat: known.lat, lng: known.lng, name: known.n, known: true, id: s.place_id };
    const lat = parseFloat(s.lat), lng = parseFloat(s.lng);
    if (!s.place_name) err.push(`${s.seq}번: 새 장소인데 place_name 이 없습니다`);
    if (!isFinite(lat) || !isFinite(lng)) err.push(`${s.seq}번 '${s.place_name || s.place_id}': 새 장소인데 좌표(lat/lng)가 없습니다`);
    return { lat, lng, name: s.place_name, known: false, id: s.place_id || null };
  });

  /* 규격 */
  if (stops.length < STOPS_MIN) err.push(`스팟이 ${stops.length}개 — 최소 ${STOPS_MIN}개`);
  if (stops.length > STOPS_MAX) err.push(`스팟이 ${stops.length}개 — 최대 ${STOPS_MAX}개`);

  const stay = stops.reduce((a, s) => a + (+s.stay_min || 0), 0);
  if (stay < STAY_MIN) err.push(`총 체류 ${stay}분 — 최소 ${STAY_MIN}분`);
  else if (stay > STAY_WARN) err.push(`총 체류 ${stay}분 — 하루에 못 돕니다(상한 ${STAY_WARN}분)`);
  else if (stay > STAY_MAX) warn.push(`총 체류 ${stay}분 — 권장 ${STAY_MAX}분 이하`);

  /* 필수 항목 */
  const tlen = [...(head.title || "")].length;
  if (!head.title) err.push("title 이 없습니다");
  else if (tlen < TITLE_MIN || tlen > TITLE_MAX) err.push(`제목이 ${tlen}자 — ${TITLE_MIN}~${TITLE_MAX}자`);
  if (!head.mood) err.push("mood(한 줄 요약)가 없습니다");
  if (!head.note) err.push("note(주의사항)가 없습니다");
  else if (!/출구|[가-힣]역|정문|입구|주차|에서 시작|에서 만나/.test(head.note)) err.push("note 에 출발 지점(몇 번 출구 등)이 없습니다");
  if (!head.area_id) err.push("area_id 가 없습니다");

  /* 코멘트 */
  stops.forEach(s => {
    const c = s.comment || "", len = [...c].length, who = `${s.seq}번 '${pts[stops.indexOf(s)].name || s.place_id}'`;
    if (!c) { err.push(`${who}: 코멘트가 없습니다`); return; }
    if (len < CMT_MIN) err.push(`${who}: 코멘트가 ${len}자 — 최소 ${CMT_MIN}자`);
    if (len > CMT_MAX) warn.push(`${who}: 코멘트가 ${len}자 — 권장 ${CMT_MAX}자 이하`);
    const hit = CLICHE.filter(w => c.includes(w));
    if (hit.length) err.push(`${who}: 상투어 — "${hit.join('", "')}" (다른 곳에 붙여도 말이 되는 문장입니다)`);
    if (!/[0-9]|시|분|층|출구|요일|월|화|수|목|금|토|일/.test(c))
      warn.push(`${who}: 구체적 정보(시간·층·요일·번호)가 없습니다 — 가본 사람만 아는 내용인지 확인하세요`);
  });

  /* 구간 거리 — 차 루트는 제외(차는 7km가 문제되지 않는다) */
  const transport = head.transport || "transit";
  if (transport !== "car") {
    for (let i = 0; i < pts.length - 1; i++) {
      if (!isFinite(pts[i].lat) || !isFinite(pts[i + 1].lat)) continue;
      const m = Math.round(haversine(pts[i], pts[i + 1]) * DETOUR);
      const pair = `${pts[i].name} → ${pts[i + 1].name}`;
      if (m > LEG_MAX_M)  err.push(`${pair}: ${(m/1000).toFixed(1)}km — 환승 구간이 됩니다(상한 ${LEG_MAX_M/1000}km)`);
      else if (m > LEG_WARN_M) warn.push(`${pair}: ${(m/1000).toFixed(1)}km — 지하철 구간입니다. 의도한 것인지 확인하세요`);
    }
  }

  /* 중복 스팟 */
  const ids = pts.map(p => p.id || p.name);
  if (new Set(ids).size !== ids.length) err.push("같은 스팟이 두 번 들어 있습니다");

  report.push({ key, title: head.title || "(제목 없음)", err, warn });
  if (!err.length) passed.push({ key, head, stops, pts });
}

/* ── 출력 ── */
let nErr = 0;
for (const r of report) {
  const mark = r.err.length ? "반려" : r.warn.length ? "통과(확인요)" : "통과";
  console.log(`\n[${mark}] ${r.key} — ${r.title}`);
  r.err.forEach(e => console.log(`   ✗ ${e}`));
  r.warn.forEach(w => console.log(`   · ${w}`));
  if (r.err.length) nErr++;
}
console.log(`\n─────────────────────────────────`);
console.log(`루트 ${report.length}개 · 통과 ${passed.length} · 반려 ${nErr}`);

if (!passed.length) { console.log("SQL 을 만들 루트가 없습니다."); process.exit(nErr ? 1 : 0); }

const q = v => (v == null || v === "" ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const sql = [`-- 신규 루트 — tools/route-import.js 생성 (${path.basename(file)})`,
             AUTHOR === "@AUTHOR_ID@" ? "-- ⚠️ 작성자 자리가 '@AUTHOR_ID@' 입니다. 실제 계정 UUID 로 치환하세요." : "",
             "", "begin;", ""].filter(Boolean);

for (const p of passed) {
  /* 새 장소를 먼저 넣는다 — 검수 전이므로 status='pending' */
  p.pts.forEach((pt, i) => {
    if (pt.known) return;
    const s = p.stops[i];
    const pid = pt.id || ("u_" + uuidOf(p.key + ":" + i).slice(0, 12));
    pt.id = pid;
    sql.push(`insert into places (id,name,cat,area_id,lat,lng,cost_lo,cost_hi,status,created_by,verified_at) values (` +
      `${q(pid)},${q(pt.name)},${q(s.place_cat || "복합공간")},${q(p.head.area_id)},${pt.lat},${pt.lng},` +
      `${+s.cost_lo || 0},${+s.cost_hi || 0},'pending',${AUTHOR === "@AUTHOR_ID@" ? "'@AUTHOR_ID@'" : `'${AUTHOR}'`},now()) ` +
      `on conflict (id) do nothing;`);
  });

  const rid = uuidOf("import:" + p.key);
  sql.push(`insert into routes (id,author_id,area_id,title,mood,note,transport,people,plan,status,published_at) values (` +
    `'${rid}',${AUTHOR === "@AUTHOR_ID@" ? "'@AUTHOR_ID@'" : `'${AUTHOR}'`},${q(p.head.area_id)},` +
    `${q(p.head.title)},${q(p.head.mood)},${q(p.head.note)},${q(p.head.transport || "transit")},` +
    `${+p.head.people || 2},false,'public',now()) on conflict (id) do nothing;`);
  p.stops.forEach((s, i) => sql.push(
    `insert into route_stops (route_id,seq,place_id,stay_min,comment) values (` +
    `'${rid}',${i},${q(p.pts[i].id)},${+s.stay_min || 60},${q(s.comment)}) on conflict do nothing;`));
  sql.push("");
}
sql.push("commit;");
fs.writeFileSync(OUT, sql.join("\n") + "\n");
console.log(`→ ${path.relative(ROOT, OUT)} (통과분만)`);
process.exit(nErr ? 1 : 0);
