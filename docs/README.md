# 스팟스 — 런칭 준비 문서

`index.html` 하나짜리 프로토타입을 실서비스로 올리기 위한 문서와 도구.

## 문서

| 파일 | 내용 |
|---|---|
| [schema.sql](./schema.sql) | Supabase(PostgreSQL) 스키마 — 테이블 15개 + RLS |
| [루트-작성-지침서.md](./루트-작성-지침서.md) | 알바 작성자용. 규격 · 코멘트 기준 · 반려 기준 · 계약 사항 |
| [route-template.csv](./route-template.csv) | 루트 제출 양식 (한 줄 = 스팟 하나) |
| [기존루트-개선대상.md](./기존루트-개선대상.md) | 자동 검수로 걸러낸 기존 루트 81건 — 알바 첫 작업 목록 |
| `seed.sql` | 생성물. 커밋하지 않는다 — `tools/seed-export.js` 로 언제든 다시 뽑는다 |

런칭 체크리스트(실행 순서 · 법적 사항 · 사업 판단)는 이 저장소가 public 이므로 로컬에만 둔다.

## 도구

```bash
# 하드코딩 시드(지역 24 · 장소 191 · 루트 136)를 INSERT 문으로 추출
node tools/seed-export.js --official <공식계정_uuid>

# 알바 제출물 검수 + SQL 변환 (반려 있으면 종료코드 1)
node tools/route-import.js 제출물.csv --author <작성자_uuid>
```

두 스크립트 모두 `index.html`을 진실 소스로 읽는다. 데이터를 고칠 일이 있으면
`index.html`을 고치고 스크립트를 다시 돌린다 — 생성된 SQL을 손으로 고치지 않는다.

## 검증 상태 (2026-09-01)

- `schema.sql` — PostgreSQL 16에 오류 없이 적용됨 (Supabase `auth` 스키마는 스텁으로 대체)
- `seed.sql` — 지역 24 · 장소 191 · 루트 136 · 스팟 560 적재 확인, 참조 무결성 이상 없음, 재실행 멱등
- `route-import.js` — 시드 136개 전량 검수 통과(규칙 오류 0), 산출 SQL이 스키마에 적재됨
