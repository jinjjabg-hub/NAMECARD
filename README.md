# NAMECARD

## ✏️ 명함 셀프 수정 (dica-edit.js)

카드 주인이 자기 명함의 **문구(텍스트)만** 직접 고칠 수 있는 공통 스크립트입니다.
세 레포(NAMECARD · BNI-PIONEER-cards · bni-giants)의 모든 DiCA 카드가 이 파일 하나를 불러 씁니다.

**카드에 붙이는 법** — `</body>` 바로 위에 한 줄:

```html
<script src="https://jinjjabg-hub.github.io/NAMECARD/dica-edit.js" data-repo="레포이름" data-slug="폴더이름" defer></script>
```

**규칙**
- 수정 가능: `<span data-lang="kr" class="active">…</span>` 묶음(2개 언어 이상)의 문구. 사진·링크·연락처는 불가.
- 한 달(한국시간 달력 기준)에 1번 저장. 관리자 계정(jinjjabg@gmail.com)은 제한 없음, 관리자가 대신 고친 건 주인 횟수에서 빠짐.
- 한국어만 고치면 나머지 언어는 Worker가 자동 번역.
- 저장 직전에 GitHub 원본을 다시 읽어, 그 사이 파일이 바뀌었으면 저장을 막음(다른 칸 덮어쓰기 방지).

**새 카드 만들 때 지켜야 할 것** — 다국어는 반드시 `<span data-lang="xx">` 방식, 한국어 span에만 `class="active"`,
span 안에 span을 중첩하지 말 것(강조는 `<strong>`/`<em>`). 이 형식이 아니면 수정 기능이 동작하지 않습니다.
