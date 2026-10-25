// 서울시 문화행사 정보(서울 열린데이터광장 OA-15486, 공공누리 1유형) → events.json
// 실행: SEOUL_API_KEY=... node collect-events.mjs   (GitHub Actions가 매일 돌린다)
// 테스트: node collect-events.mjs --mock sample.json   (API 응답 JSON 파일로 대신 돌린다)
import { readFileSync, writeFileSync } from "node:fs";

const PAGE = 1000, MAX_PAGES = 40; // 전체 약 2만 건 — 상한을 넘으면 멈춘다
const SKIP_KINDS = new Set(["교육/체험"]); // 수강 신청형이 대부분이라 나들이 동선에 안 맞는다

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
const esc = s => String(s ?? "").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const url = s => /^https?:\/\/[^\s"'<>]+$/.test(String(s ?? "").trim()) ? String(s).trim() : null;

async function fetchAll(key) {
  const rows = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const res = await fetch(`http://openapi.seoul.go.kr:8088/${key}/json/culturalEventInfo/${p * PAGE + 1}/${(p + 1) * PAGE}/`);
    const body = (await res.json()).culturalEventInfo;
    if (!body) break; // 범위를 넘으면 culturalEventInfo 없이 RESULT만 온다
    if (body.RESULT?.CODE !== "INFO-000") throw new Error(`API ${body.RESULT?.CODE}: ${body.RESULT?.MESSAGE}`);
    rows.push(...body.row);
    if (rows.length >= body.list_total_count) return rows;
  }
  if (rows.length) return rows;
  throw new Error("받은 행사가 없다");
}

function toEvent(r) {
  const code = (String(r.HMPG_ADDR).match(/cultcode=(\d+)/) || [])[1];
  const start = String(r.STRTDATE).slice(0, 10), end = String(r.END_DATE).slice(0, 10);
  const lat = Number(r.LAT), lng = Number(r.LOT);
  if (!code || !/^\d{4}-\d\d-\d\d$/.test(start) || !/^\d{4}-\d\d-\d\d$/.test(end) || !lat || !lng) return null;
  const img = url(r.MAIN_IMG);
  return {
    id: `seoul-${code}`, title: esc(r.TITLE), kind: esc(r.CODENAME), region: esc(r.GUNAME), venue: esc(r.PLACE),
    start, end, lat, lng,
    // 운영 요일·시간은 API에 정형 값이 없다 — 하루짜리만 그날 운영이 확실하다
    daysUnknown: start !== end, proTime: esc(r.PRO_TIME) || null,
    price: esc(r.USE_FEE) || (r.IS_FREE === "무료" ? "무료" : null),
    officialUrl: url(r.HMPG_ADDR), reserveUrl: url(r.ORG_LINK), desc: esc(r.PROGRAM).slice(0, 160) || null,
    // 대표 이미지는 데이터셋 필드다 — OA-15486이 공공누리 1유형·제3저작권자 없음으로 공개(2026-10-26 확인)
    image: img ? { src: img, source: "서울문화포털", sourceUrl: url(r.HMPG_ADDR), license: "공공누리 제1유형", licenseUrl: "https://www.kogl.or.kr/info/licenseType1.do", needsReplacement: false, focalPoint: "50% 50%", fit: "contain" } : null,
    src: "seoul-open-data", checkedAt: today,
  };
}

const mock = process.argv.indexOf("--mock");
const rows = mock > 0
  ? JSON.parse(readFileSync(process.argv[mock + 1], "utf8")).culturalEventInfo.row
  : await fetchAll(process.env.SEOUL_API_KEY || (() => { throw new Error("SEOUL_API_KEY 없음"); })());

const events = rows.filter(r => !SKIP_KINDS.has(r.CODENAME)).map(toEvent)
  .filter(e => e && e.end >= today)
  .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "events.json";
// 수집 시각은 넣지 않는다 — 내용이 같으면 파일도 같아야 자동 커밋이 안 생긴다
writeFileSync(out, JSON.stringify({ source: "서울시 문화행사 정보(서울 열린데이터광장)", events }) + "\n");
console.log(`받음 ${rows.length} · 교육/체험 제외·종료 제외 후 ${events.length} → ${out}`);
