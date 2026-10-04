# NAMECARD

## ✏️ 비즈홈 셀프 수정 (dica-edit.js)

카드 주인이 자기 비즈홈의 **문구(텍스트)만** 직접 고칠 수 있는 공통 스크립트입니다.
세 레포(NAMECARD · BNI-PIONEER-cards · bni-giants)의 모든 DiCA 카드가 이 파일 하나를 불러 씁니다.

**카드에 붙이는 법** — `</body>` 바로 위에 한 줄:

```html
<script src="https://jinjjabg-hub.github.io/NAMECARD/dica-edit.js" data-repo="레포이름" data-slug="폴더이름" defer></script>
```

**버튼 표시** — 방문자에게는 보이지 않습니다. 주인에게 `카드주소?edit` 링크를 한 번 보내주면, 그 링크로 들어왔을 때 버튼이 보이고,
주인 인증에 한 번 성공한 기기에서는 이후 `?edit` 없이도 보입니다.

**규칙**
- 수정 가능: `<span data-lang="kr" class="active">…</span>` 묶음(2개 언어 이상)의 문구. 사진·링크·연락처는 불가.
- 한 달(한국시간 달력 기준)에 1번 저장. 관리자 계정(jinjjabg@gmail.com)은 제한 없음, 관리자가 대신 고친 건 주인 횟수에서 빠짐.
- 한국어만 고치면 나머지 언어는 Worker가 자동 번역.
- 저장 직전에 GitHub 원본을 다시 읽어, 그 사이 파일이 바뀌었으면 저장을 막음(다른 칸 덮어쓰기 방지).

**새 카드 만들 때 지켜야 할 것** — 다국어는 반드시 `<span data-lang="xx">` 방식, 한국어 span에만 `class="active"`,
span 안에 span을 중첩하지 말 것(강조는 `<strong>`/`<em>`). 이 형식이 아니면 수정 기능이 동작하지 않습니다.

### 📣 소식 올리기 (프리미엄 전용)

`?edit` 화면의 **📣 소식 올리기** — 종류·사진·제목·설명(AI 초안)·링크 3개·유튜브·가격·노출기간을 입력하면
Worker 가 4개 언어(en·jp·cn·hi)로 번역해 `카드폴더/news.json` 과 `카드폴더/news/이미지` 를 커밋합니다. 1~2분 뒤 소식판에 반영. 횟수 제한 없음.
사진은 브라우저에서 1200px 로 줄여 보내고, 동영상 파일은 아직 미지원(유튜브 링크만).

**올린 소식 관리** — 소식 올리기 창 맨 위 "📋 올린 소식 관리": 목록 보기, **숨기기/보이기**(모든 글), **삭제**(고객이 직접 올린 글만 · 사진도 함께 삭제). 관리자 계정은 전부 삭제 가능.

**켜는 법 (카드별 · 시범은 송승훈만)** — 관리자가 한 번 호출:
```
curl -X POST https://dica-editor.jinjjabg.workers.dev/admin/premium \
  -H "X-Admin-Key: <ADMIN_KEY>" -H "Content-Type: application/json" \
  -d '{"repo":"BNI-PIONEER-cards","slug":"송승훈","on":true}'
```
끄려면 `"on":false`. 프리미엄이 아닌 카드에는 버튼이 나타나지 않고, 서버도 거절합니다(403 `not-premium`).

### 서버 (worker/worker.js)

`dica-editor.jinjjabg.workers.dev` 에서 돌아가는 Cloudflare Worker 원본입니다. 비밀 값(토큰·API 키)은 코드에 없고 Cloudflare 환경 변수에만 있습니다.

**배포**: Cloudflare Workers Builds(GitHub 자동 배포)에 연결돼 있으면, `worker/` 폴더 변경이 main 에 합쳐질 때 자동 배포됩니다
(설정: `worker/wrangler.toml`, 루트 폴더 `worker`, 변경 감지 경로 `worker/*`).
연결 전이거나 급할 때: 대시보드 → Workers & Pages → dica-editor → Edit code → `worker/worker.js` 전체 붙여넣기 → Deploy.

서버가 막는 것: 주인·관리자 외 저장, 월 1회 초과, 그 사이 바뀐 문구 덮어쓰기, 비즈홈 레포 밖 파일 쓰기, 허용 외 HTML, 줄이 빠진 번역(재시도 후에도 빠지면 저장 안 함).
