#!/usr/bin/env node
/* 사진 외부화 — index.html 에 base64 로 박힌 사진 50장을 파일로 빼낸다.
 *
 * 왜 필요한가
 *   지금 index.html 이 2.5MB 이고 그 대부분이 사진이다. 첫 방문자가 화면을 보기까지
 *   사진 50장을 전부 받아야 한다 — 한 장도 안 보이는 화면을 기다리면서.
 *   파일로 빼면 HTML 이 200KB 대로 떨어지고, 사진은 화면에 필요한 것부터 따로 온다.
 *
 * 사용법
 *   node tools/photo-extract.js                       추출만 (assets/photos/)
 *   node tools/photo-extract.js --apply https://cdn.example.com/photos
 *                                                     추출 + index.html 의 PHOTO 를 URL 로 교체
 *   node tools/photo-extract.js --apply ./assets/photos
 *                                                     같은 저장소에 두고 상대경로로 쓸 때
 *
 * ⚠️ --apply 는 index.html 을 실제로 고친다. 사진을 그 주소에 올린 **뒤에** 실행할 것.
 *    먼저 실행하면 사진이 전부 안 보인다(폴백 아트만 나온다 — 화면이 깨지지는 않는다).
 */
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

const ROOT = path.join(__dirname, "..");
const HTML = path.join(ROOT, "index.html");
const OUTDIR = path.join(ROOT, "assets", "photos");

const argv = process.argv.slice(2);
const applyAt = (() => { const i = argv.indexOf("--apply"); return i >= 0 ? argv[i + 1] : null; })();
if (argv.includes("--apply") && !applyAt) { console.error("--apply 뒤에 사진을 올릴 주소를 적으세요"); process.exit(2); }

let html = fs.readFileSync(HTML, "utf8");

/* PHOTO 선언 구간을 잘라낸다 — base64 안에 중괄호가 없으므로 깊이 세기로 충분하다 */
const head = "const PHOTO={";
const at = html.indexOf(head);
if (at < 0) { console.error("PHOTO 선언을 못 찾았습니다. 이미 외부화된 것 같습니다."); process.exit(1); }
let i = at + head.length, depth = 1, str = null, esc = false;
while (i < html.length && depth > 0) {
  const c = html[i];
  if (str) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === str) str = null; }
  else if (c === '"' || c === "'") str = c;
  else if (c === "{") depth++;
  else if (c === "}") depth--;
  i++;
}
const declStart = at, declEnd = i;                 // '}' 까지
const PHOTO = eval("(" + html.slice(at + "const PHOTO=".length, i) + ")");

/* 파일명 — 키가 한글이라 그대로 쓰면 URL 인코딩이 CDN 마다 다르게 처리된다.
   내용 해시로 짓는다. 같은 사진이 두 키에 붙어 있어도 파일 하나만 남는다. */
fs.mkdirSync(OUTDIR, { recursive: true });
const map = {};
let bytes = 0, files = 0;
const seen = new Map();

for (const [key, uri] of Object.entries(PHOTO)) {
  const m = /^data:image\/(\w+);base64,(.+)$/s.exec(uri || "");
  if (!m) { console.warn(`건너뜀 — ${key}: data URI 가 아닙니다`); continue; }
  const [, ext, b64] = m;
  const buf = Buffer.from(b64, "base64");
  const h = createHash("sha1").update(buf).digest("hex").slice(0, 12);
  const name = `${h}.${ext === "jpeg" ? "jpg" : ext}`;
  if (!seen.has(h)) {
    fs.writeFileSync(path.join(OUTDIR, name), buf);
    seen.set(h, name); bytes += buf.length; files++;
  }
  map[key] = seen.get(h);
}

console.log(`사진 ${Object.keys(map).length}개 → 파일 ${files}개 (${(bytes / 1048576).toFixed(2)}MB)`);
console.log(`→ ${path.relative(ROOT, OUTDIR)}/`);

/* 매핑을 남긴다 — CDN 에 올린 뒤 무엇이 무엇인지 확인할 때 쓴다 */
fs.writeFileSync(path.join(OUTDIR, "index.json"), JSON.stringify(map, null, 1) + "\n");

if (!applyAt) {
  const after = html.length - (declEnd - declStart) + JSON.stringify(map).length + 200;
  console.log(`\n--apply 로 교체하면 index.html 이 ` +
    `${(html.length / 1048576).toFixed(2)}MB → 약 ${(after / 1024).toFixed(0)}KB 가 됩니다.`);
  console.log(`사진을 올린 뒤 실행하세요:  node tools/photo-extract.js --apply <주소>`);
  process.exit(0);
}

/* ── 교체 ── */
const base = applyAt.replace(/\/+$/, "");
const decl =
`/* ═════ 사진 ═════
   base64 로 박혀 있던 것을 파일로 뺐다(tools/photo-extract.js).
   HTML 이 2.5MB 였던 이유가 이것이고, 그동안 첫 화면이 사진 50장을 다 받을 때까지 기다렸다.
   주소를 바꾸려면 PHOTO_BASE 한 줄만 고친다. 파일을 못 받으면 <img> 의 onerror 가
   스스로를 지우고 폴백 아트가 남는다 — 화면은 깨지지 않는다. */
const PHOTO_BASE=${JSON.stringify(base)};
const PHOTO_FILE=${JSON.stringify(map, null, 1)};
const PHOTO=new Proxy({},{get:(_,k)=>PHOTO_FILE[k]?PHOTO_BASE+"/"+PHOTO_FILE[k]:undefined,
  has:(_,k)=>k in PHOTO_FILE}`+`)`;

html = html.slice(0, declStart) + decl + html.slice(declEnd);
fs.writeFileSync(HTML, html);
console.log(`\nindex.html 교체 완료 — ${(fs.statSync(HTML).size / 1024).toFixed(0)}KB`);
console.log(`사진 주소: ${base}/<파일명>`);
