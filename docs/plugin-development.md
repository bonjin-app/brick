# 플러그인 개발 가이드

Brick 플러그인은 **사전 빌드된 JavaScript + manifest + SQL 마이그레이션**을 ZIP으로 배포합니다.
서버는 절대 빌드하지 않습니다 — 관리자 화면에서 ZIP을 올리면 곧바로 실행됩니다.

## 시작은 템플릿으로

```bash
npm create brick-plugin my-plugin
```

빈 껍데기가 아니라 **동작하는 방명록**이 생성됩니다 — 라우트·블록·관리
화면·마이그레이션·개인정보 파기까지, 이 문서의 계약 전부를 한 번씩 씁니다.
지우면서 바꿔 나가세요. 생성된 README 에 빌드→ZIP→업로드 절차가 있습니다.

의존성 규칙: `@brick/plugin-sdk` · `drizzle-orm` · `uuidv7` 은 Brick 이 함께
설치하므로 **번들하지 마세요** (특히 drizzle-orm — 다른 사본의 `sql` 객체는
서버가 알아보지 못합니다). 그 외의 의존성은 dist 에 번들해야 합니다.

## 다국어 (ctx.t)

블록·라우트가 그리는 **공개 문자열**은 하드코딩하지 말고 카탈로그에 두세요:

```
my-plugin/
├── locales/
│   ├── ko.json    # { "entries.empty": "아직 글이 없습니다." }
│   └── en.json    # { "entries.empty": "No entries yet." }
```

```ts
ctx.t("entries.empty")            // 사이트 언어(site.locale)의 문구
ctx.t("hello", { name: "홍" })    // "{name}" 치환
ctx.locale                        // 현재 사이트 언어 ("ko" | "en")
```

요청 언어에 키가 없으면 ko → 키 자체 순서로 폴백하고 서버 로그에 남습니다 —
번역이 빠지면 빠진 것이 보입니다. 템플릿(`npm create brick-plugin`)이 이
구조를 그대로 시연합니다.

**관리 화면의 선언 라벨**(registerAdminResource 의 title/label/help/
placeholder/options, 관리 메뉴 label)은 ctx.t 를 쓰지 않습니다 — 선언은
활성화 때 한 번 고정되어 언어 변경을 따라갈 수 없기 때문입니다. 대신
gettext 방식입니다: **선언에 쓴 원문이 곧 카탈로그 키**이고, 서버가 서빙
시점에 번역합니다. `locales/en.json` 에 원문을 키로 추가하면 됩니다:

```json
{ "주문": "Orders", "주문번호": "Order no." }
```

번역이 없는 라벨은 원문이 그대로 나갑니다 (선언 코드는 바꿀 것이 없습니다).

## 헤더에 링크 놓기 (registerHeaderAction)

손님이 **모든 화면에서 한 번에 닿아야 하는 곳**이 있다면 헤더에 등록하세요.
쇼핑몰의 장바구니가 그렇습니다 — 담기는 상품 상세에서 되지만, 담은 다음에
갈 곳이 헤더에 없으면 주소를 외워야 합니다.

```ts
ctx.registerHeaderAction({ label: "장바구니", path: "/shop/cart", order: 10 });
ctx.registerHeaderAction({ label: "쪽지함", path: "/memo", requiresLogin: true });
```

- `label` 은 관리 라벨과 같은 gettext 방식입니다(원문이 번역 키).
- `requiresLogin` 이면 비로그인 손님에게는 나오지 않습니다.
- **숫자 배지(장바구니 개수)는 라벨에 넣지 말고 `count` 로 주세요.** 비로그인
  렌더는 캐시되므로 라벨에 숫자를 넣으면 남의 값이 새어 나갑니다. `count` 는
  **어디서 세는지**만 알려 주고, 숫자는 손님의 브라우저가 가져옵니다:

  ```ts
  ctx.registerHeaderAction({
    label: "장바구니", path: "/shop/cart", icon: "cart",
    // { count: number } 를 주는 GET 경로 · 비회원을 알아보는 브라우저 저장소 키(있으면 ?guest= 로 붙는다)
    count: { url: "/api/plugins/brick-shop/cart/count", guestKey: "brick_shop_guest" },
  });
  ```

  개수가 바뀌는 순간(담기·지우기)에는 `document.dispatchEvent(new CustomEvent("brick:count-changed"))`
  를 보내세요 — 테마가 듣고 다시 셉니다. 모든 페이지가 부르는 경로이니 가볍게(금액 계산 없이) 만드세요.
- `place: "util"` 로 등록한 링크(주문조회 · 고객센터)는 맨 위 띠, 쇼핑몰 테마 푸터의 고객센터 칸,
  **로그인 화면**(테마 밖 — `/api/i18n` 의 `guestLinks`)에 함께 나옵니다.
- 좁은 화면에서는 기본 테마가 **첫 항목만** 남깁니다 — 헤더가 두 줄이 되면
  안 되므로. 중요한 것에 작은 `order` 를 주세요.

## 화면 제목 (ctx.setSeo)

블록 하나가 URL 로 여러 화면을 전환한다면(목록/상세/작성) **화면 제목을
직접 알려주세요.** 안 하면 그 페이지의 제목이 모든 화면에 쓰입니다 — 글
상세의 브라우저 탭·공유 미리보기·검색 결과가 전부 "게시판"이 됩니다.

```ts
ctx.registerBlock({
  name: "board",
  render: async (props, ctx) => {
    const post = await loadPost(ctx.pathTail);
    ctx.setSeo?.({
      title: post.title,
      description: excerpt(post.content),  // 공유 미리보기 문구
      ownHeading: true,                    // 이 화면의 h1 은 내가 그린다
      image: post.thumbUrl,                // 공유 미리보기 이미지 (og:image)
    });
    return `<h1>${escapeHtml(post.title)}</h1>…`;
  },
});
```

- **`ownHeading` 은 "누가 화면 제목을 그리는가"입니다** — 문서 제목과 별개
  문제입니다. 생략하면 테마가 그 제목을 h1 으로 그려 주고(장바구니·주문서처럼
  자기 제목을 그리지 않는 화면), `true` 면 테마는 그리지 않습니다(이미 그렸으니).
  잘못 주면 제목이 두 번 나오거나 h1 없는 문서가 됩니다 — 화면을 보면 압니다.
- 운영자가 페이지 SEO 를 직접 적었다면 **그것이 이깁니다.** 자동 추론이
  사람이 적은 값을 덮으면 안 됩니다.
- 권한이 없어 내용을 감춘 화면(비밀글)에서는 **부르지 마세요** — 제목과 요약이
  캐시와 검색엔진에 남습니다.
- **`image` 는 이 화면을 공유할 때의 미리보기 이미지**입니다(상품 사진·글의 첫 이미지). 주지 않으면
  사이트 공통 이미지(관리자 → 사이트 설정의 공유 이미지)가 나갑니다 — 상품 링크를 카카오톡에 붙였는데
  로고가 뜨면 공유가 헛돕니다. `/uploads/…` 같은 경로는 렌더러가 절대 주소로 바꿉니다. http(s) 나 `/`
  로 시작하지 않는 값(`//남의주소`, `javascript:` 포함)은 버립니다. 테마는 고칠 필요가 없습니다 — 이 화면에
  한해 `site.ogImage` 가 이 값으로 바뀝니다.

## 헤더 링크 (registerHeaderAction)

장바구니·쪽지함처럼 **모든 화면에서 한 번에 닿아야 하는 자리**는 헤더 유틸 영역입니다.
테마는 쇼핑몰·쪽지를 모르므로 플러그인이 등록합니다.

```ts
ctx.registerHeaderAction({ label: "장바구니", path: "/shop/cart", order: 10, icon: "cart" });
ctx.registerHeaderAction({ label: "쪽지함", path: "/memo", requiresLogin: true, icon: "message" });
```

- `label` 은 원문이 번역 키입니다(locales/en.json 에 `"장바구니": "Cart"`).
- `requiresLogin` 이 true 면 비로그인 손님에게는 나오지 않습니다.
- `icon` 은 테마 스프라이트의 심볼 이름입니다(테마 개발 가이드의 목록). 테마에 없으면
  문구만 남습니다.
- **숫자 배지처럼 사용자별 값은 여기 담지 마세요** — 비로그인 렌더는 캐시되므로 남의
  값이 새어 나갑니다. 배지는 블록이 클라이언트에서 채웁니다.

## 폼 오류는 어느 칸인지 알려주세요

던지는 오류에 `field` 를 실으면 코어가 응답에 함께 담습니다
(`{ statusCode, message, field }`). 화면은 그 칸에 `aria-invalid` 를 걸고 포커스를
옮길 수 있습니다.

```ts
throw new MyError(400, "연락처 형식이 올바르지 않습니다.", "ordererPhone");
```

칸이 여덟 개인 주문서에서 메시지만 받으면 손님은 위로 올라가 하나씩 되짚어야 하고,
그 지점이 결제 직전입니다. 칸을 특정할 수 없는 오류(장바구니가 비었다 등)는 `field` 없이
던지세요 — 화면이 메시지로 안내합니다.

## 목록에는 목록에 필요한 것만

관리 화면은 수정 폼을 **단건 라우트**(`GET <basePath>/:id`)에서 채웁니다. 목록에 폼용
데이터까지 실으면 한 화면 응답이 커집니다 — 상품 목록에서 실측으로 응답의 76%가 상세
HTML 이었고(30건 45KB), 사진과 표가 든 실제 상품이면 수 MB 가 됩니다.

- **목록 라우트**: 목록에 보이는 것(+ id) 만
- **단건 라우트**: 폼이 편집할 모든 것. 되돌려 보내지 않은 값은 저장할 때 **지워진 것으로
  오해**됩니다(관련 상품이 매번 날아갔습니다)

단건 라우트가 없으면 화면이 목록 행으로 폼을 채우므로, 구현하지 않은 플러그인도 그대로
동작합니다 — 다만 그때는 폼에 필요한 것을 목록에 실어야 합니다.

## 운영자 권한 범위 — 플러그인이 할 일은 없다

관리자는 운영자마다 관리 화면을 골라 줄 수 있습니다("이 운영자는 주문만"). 검사는 **디스패처가**
합니다 — 플러그인은 지금처럼 역할(`admin`·`manager`)만 보면 됩니다. 어느 경로가 어느 화면의 것인지는
리소스 선언에서 만듭니다: `basePath` 아래 전부, 그리고 그 화면이 부르는 `optionsFrom`(필드·필터·일괄
작업 입력)과 `importFrom.path`. 그러니 **화면이 부르는 경로는 이 선언 안에 두세요.** 선언 밖의
`/admin/...` 경로(화면 없는 보고서 API 등)는 플러그인 전체를 받은 운영자만 닿습니다 — 모르는 것은
닫는 쪽으로 틀립니다.

## 관리자 전용 화면 (AdminResource.adminOnly)

관리 라우트는 기본적으로 **운영자(manager)까지** 열려 있습니다(디스패처가 그 선을
지킵니다). 더 좁혀야 하는 라우트는 자기 줄에서 다시 막으면 되는데, 그러면 **목록은
그 사정을 모릅니다** — 결제 시크릿 키처럼 관리자만 쓰는 화면이 운영자 사이드바에
뜨고, 누르면 403 이 납니다.

```ts
ctx.registerAdminResource({
  name: "config",
  kind: "settings",
  title: "토스페이먼츠",
  adminOnly: true,   // 목록에서도 가린다 (라우트의 자기 검사는 그대로 둔다)
  // …
});
```

`adminOnly` 는 **보여줄지**를 정할 뿐입니다. 권한은 여전히 라우트가 지킵니다 —
선언만 믿고 핸들러의 검사를 빼지 마세요.

## 붙여넣어 등록 (AdminResource.importFrom)

폼은 한 번에 하나입니다. 이백 행을 옮겨 오는 날 그것은 이백 번이고, 그래서 기존 사이트는
이사를 포기합니다.

```ts
importFrom: {
  path: "/import",              // basePath 기준
  label: "붙여넣어 등록",
  help: "엑셀에서 머리글째 복사해 붙여넣으세요…",
  sample: "주소\t상품명\t판매가\nmug-white\t머그컵\t12000",
}
```

라우트는 `{ text }` 를 받아 `{ created, updated, failed: [{ line, message }] }` 를
돌려줍니다. 세 가지를 지키세요.

- **파일이 아니라 붙여넣기입니다.** 실무의 원본은 엑셀이고, 범위를 복사하면 탭으로 구분된
  텍스트가 그대로 옵니다. 파일로 받으면 "저장 → 형식 고르기 → 업로드"가 앞에 붙는데,
  그 세 단계에서 사람이 가장 많이 미끄러집니다.
- **키가 있으면 수정입니다.** 같은 파일을 두 번 붙여넣어 행이 두 벌 생기면 안 됩니다.
- **실패한 줄만 건너뜁니다.** 오타 하나로 이백 줄을 막으면 어느 줄이 문제인지 찾다가
  그만둡니다 — 대신 몇 번째 줄이 왜 실패했는지 정확히 돌려주세요.

## 목록 필터 (AdminResource.filters)

목록이 길어지면 필터 없이는 쓸 수 없습니다. 대시보드가 "발송 대기 12건"이라고 알려도
목록에 가면 취소·배송완료까지 섞인 전체가 나오고, 운영자는 그 열두 건을 눈으로 찾습니다.

```ts
filters: [
  { name: "status", label: "주문 상태", options: [{ value: "paid", label: "결제완료" }] },
  { name: "category", label: "분류", optionsFrom: "/admin/options/categories" },
]
```

고른 값은 목록 라우트에 `?status=paid` 로 옵니다. **거르는 일은 플러그인이 합니다** —
코어는 그 테이블의 뜻을 모릅니다. 두 가지를 지키세요.

- 모르는 값은 무시하고 전체를 주세요. 쿼리스트링을 그대로 SQL 에 붙이면 안 됩니다.
- `count` 와 목록이 **같은 조건**을 써야 합니다. 다르면 "37건"이라 표시하고 20건만 보여줍니다.

화면은 주소의 쿼리를 초기값으로 읽으므로, 대시보드 카드가
`/admin/x/my-plugin/orders?status=paid` 로 곧바로 보낼 수 있습니다. 카드의 `load` 가
`link` 를 돌려주면 **그때 가장 급한 곳**으로 바꿀 수 있습니다 — 입금 확인이 0 인데
입금 대기 목록으로 보내면 빈 화면이 나옵니다.

### 탭으로 그리는 필터 (`display: "tabs"`)

주문 상태처럼 운영자가 **매번** 고르는 필터는 드롭다운이면 두 번 눌러야 하고, 지금 어느
상태에 일이 있는지 보이지 않습니다. `display: "tabs"` 를 주면 목록 위에 "전체 · 입금대기 ·
결제완료 …" 탭 줄로 그립니다. 목록 응답에 `facets` 를 실으면 탭이 건수를 함께 씁니다.

```ts
filters: [{ name: "status", label: "주문 상태", display: "tabs", options: [...] }]
// 목록 라우트의 응답
return { items, total, facets: { status: { pending: 3, paid: 5 } } };
```

건수는 **그 필터를 뺀 나머지 조건**(검색어)으로 세세요. 배송중 탭을 보는 중에도 입금대기 탭의
숫자가 그대로여야 하고, 탭을 눌렀을 때 그 숫자만큼 나와야 합니다.

## 목록 검색 (AdminResource.searchable)

필터만으로는 부족합니다. 주문이 오천 건인 가게에서 손님이 전화로 "제 주문 어디쯤
왔나요" 라고 물으면, 운영자는 상태를 고른 뒤 서른 건씩 넘기며 이름을 눈으로 찾습니다 —
그 시간에 손님은 기다립니다.

```ts
searchable: { placeholder: "주문번호 · 주문자 · 받는 분 · 연락처" },
```

선언하면 코어 관리 화면이 검색칸을 그리고 입력을 `?q=<입력>` 으로 넘깁니다.
**무엇을 검색할지는 플러그인이 정합니다** — 코어는 그 테이블의 뜻을 모릅니다.
`placeholder` 에 **무엇으로 찾을 수 있는지** 적으세요(원문이 번역 키입니다).

세 가지를 지키세요.

- **`%` 와 `_` 를 이스케이프하세요.** 안 하면 `%` 한 글자로 전체가 나옵니다 —
  좁히려고 친 검색어가 아무것도 좁히지 않습니다.
- `count` 와 목록이 **같은 조건**을 써야 합니다(필터와 같은 규칙).
- 긴 본문은 대상에서 빼는 편이 낫습니다. 수만 건을 훑느라 목록 화면이 느려지고,
  운영자가 찾는 것은 대개 제목·이름·번호입니다.

### 검색어의 **모양**을 보고 가지를 가르세요

`ILIKE '%…%'` 는 인덱스를 쓰지 못합니다. 주문 20만 건에서 실제로 재 본 값입니다.

| 검색어 | 고치기 전 | 고친 뒤 |
|---|---|---|
| 주문번호 전체 (`20260921-000001`) | 278.6ms | **0.4ms** |
| 연락처 (`010-1111-2222`) | 0.3ms | 0.4ms |
| 이름 (`김철수`) | 0.2ms | 0.3ms |
| 맞는 것이 없는 오타 | 46.4ms | 62.3ms |

두 가지를 했습니다.

- **주문번호처럼 생겼으면 주문번호만, 접두사로** 찾습니다(`'2026…%'`). unique
  인덱스를 타므로 0.4ms 입니다. 이름·연락처까지 함께 훑으면 접두사로 바꿔도
  94ms 였습니다 — 아무의 이름에도 그 숫자는 들어 있지 않으니 헛일입니다.
- **행마다 계산하는 조건**(`regexp_replace(phone, …) ILIKE …`)은 그 모양일 때만
  켭니다. 늘 켜 두었더니 맞는 것이 없을 때 391.8ms 였습니다.

다만 **빠른 것보다 맞는 것이 먼저입니다.** 처음에 "숫자 여덟 자 이상이면
주문번호" 로 잡았더니 `010-1111-2222`(숫자 11개)가 주문번호로 분류되어 연락처
가지를 건너뛰었고, **찾던 주문이 안 나왔습니다.** 경계는 열두 자리입니다
(주문번호 14 · 휴대폰 11 · 유선 9~10). 스모크가 그 경계를 못박습니다.

인덱스는 **넣지 않았습니다.** 20만 건에서 최악(맞는 것이 없는 검색)이 60ms 대라
운영자 화면에서 감당되고, 부분일치를 인덱스로 받으려면 `pg_trgm` 확장이 필요한데
관리형 DB 에서는 설치 권한이 없을 수 있습니다 — 설치가 실패하는 대가로 얻을
속도가 아닙니다.

검색어는 **누른 뒤에** 전송됩니다(한 글자마다가 아니라) — 오천 건짜리 테이블을
여섯 번 훑지 않게 하려는 것입니다. 화면은 주소의 `?q=` 도 초기값으로 읽으므로
운영자가 검색 결과 링크를 그대로 보낼 수 있습니다.

## 일괄 작업의 입력

`bulkActions[].input` 은 두 가지입니다. `optionsFrom` 을 주면 **고르는** 값이고(라우트가
`[{ value, label }]` 을 돌려줍니다), `type: "textarea"` 를 주면 **붙여넣는** 값입니다.

```ts
{
  code: "set-tracking",
  label: "송장번호 입력 + 발송",
  input: { name: "tracking", label: "주문번호와 송장번호 (한 줄에 하나)",
           type: "textarea", placeholder: "…", help: "…" },
}
```

선택지로 표현할 수 없는 입력이 있습니다: 택배사에서 받은 송장번호처럼 값이 행마다 다르고
밖에서 옵니다. 그것을 선택지로 만들려면 행마다 칸을 그려야 하고, 그러면 스무 건에 스무 번
타이핑입니다. 값은 `params[name]` 으로 그대로 옵니다 — 파싱은 플러그인이 합니다.

라우트는 `{ ok, affected, skipped }` 를 돌려주세요. `skipped` 가 있으면 화면이 "3건을
처리했습니다. 2건은 지금 상태에서 할 수 없어 건너뛰었습니다."로 알려줍니다 — 건너뛴 것을
말하지 않으면 운영자는 나머지를 어디서 찾을지 모릅니다.

## 대시보드 카드 (registerDashboardCard)

관리자 첫 화면에 "오늘의 숫자"를 올립니다. 등록하지 않으면 운영자는
그 숫자를 보러 매번 관리 화면으로 들어가야 합니다.

```ts
ctx.registerDashboardCard({
  title: "오늘 주문",                       // 원문이 번역 키 (en.json 에 추가)
  order: 20,                               // 작을수록 먼저
  link: "/admin/x/my-plugin/orders",       // 누르면 이동 (선택)
  load: async () => ({                     // 요청 시점에 실행
    value: 12,
    sub: ctx.t("dash.awaiting", { n: 3 }), // 동적 문구는 ctx.t
  }),
});
```

`load` 가 던지거나 3초를 넘기면 그 카드만 오류로 표시됩니다 — 다른
카드와 대시보드는 그대로 나갑니다. "오늘"을 세는 쿼리는 사이트
시간대(SDK 가 재수출하는 `SITE_TZ` 상수)로 날짜를 잘라야 리포트와
숫자가 맞고, **컬럼이 아니라 상수 쪽을 변환**해야 인덱스를 탑니다:

```sql
created_at >= (date_trunc('day', now() AT TIME ZONE ${SITE_TZ}) AT TIME ZONE ${SITE_TZ})
```

## 마이페이지 첫머리 요약 (registerMemberSummary)

마이페이지 맨 위에는 **그 회원 자신의 숫자**가 놓입니다 — 적립금 · 쿠폰 · 주문 처리 현황.
코어는 쇼핑몰을 모르므로 확장이 선언하고 코어가 그립니다(대시보드 판과 같은 방식).

```ts
ctx.registerMemberSummary({
  order: 20,
  load: async (userId) => ({
    // 숫자 칸 — 값은 화면에 그대로 쓰는 문자열
    stats: [{ label: ctx.t("쿠폰"), value: ctx.t("{n}장", { n: 2 }), link: "/shop/coupons" }],
    // 흐름 한 줄 — 단계 이름과 건수
    flow: { title: ctx.t("주문 처리 현황"), link: "/shop/orders",
            steps: [{ label: ctx.t("입금대기"), value: 0 }, { label: ctx.t("배송중"), value: 1 }] },
  }),
});
```

- `load` 는 **로그인한 회원 본인**에게만 불립니다(`GET /api/member/summary`). 다른 회원의 값을 섞지 않게
  질의에 `userId` 를 꼭 거세요.
- 한 확장이 실패하거나 2.5초를 넘기면 그 칸만 빠지고 마이페이지는 뜹니다.
- 링크는 사이트 안 경로만 남습니다.
- 끝없이 쌓이는 상태(배송완료)는 기간을 두세요 — 쇼핑몰은 최근 3개월을 셉니다.

## 사이드바 묶음 (AdminResource.section)

관리 화면을 사이드바의 어느 묶음에 넣을지 정합니다. 운영자가 하는 **일**로 나눕니다 —
플러그인 경계는 운영자가 모릅니다(쇼핑몰의 "회원 등급" 은 고객 일이고, 쿠폰은 프로모션 일입니다).

| section | 묶음 | 예 |
|---|---|---|
| `order` | 주문 | 주문 · 취소/반품 · 영수증 · 정기배송 |
| `product` | 상품 | 상품 · 분류 · 기획전 · 후기 · 상품 문의 |
| `customer` | 고객 | 회원 등급 · 포인트 · 1:1 문의 · 쪽지 |
| `board` | 게시판 | 게시판 · 게시글 · FAQ · 설문 |
| `promotion` | 프로모션 | 쿠폰 · 팝업 |
| `design` | 디자인 | (코어: 테마 · 페이지 · 메뉴 · 미디어) |
| `settings` | 설정 | 각 기능의 설정 화면 · 결제 · 배송 |

없거나 모르는 값이면 "플러그인" 묶음으로 갑니다(오타가 새 묶음을 만들지 않게). 묶음 안의 순서는 `order` 입니다.

## 대시보드 판 (registerDashboardPanel)

카드는 숫자 하나입니다. **흐름**(입금전 → 결제완료 → 배송중), **추이**(최근 14일 매출),
**최근 목록**은 판으로 그립니다. 모양은 셋이고 코어가 그립니다 — 빌드 없이 배포되는 플러그인도 씁니다.

```ts
ctx.registerDashboardPanel({
  title: "주문 현황", order: 10, link: "/admin/x/my-plugin/orders",
  load: async () => ({
    kind: "steps",
    groups: [{ label: ctx.t("dash.flow"), flow: true, steps: [
      { label: ctx.t("입금대기"), value: 3, link: "/admin/x/my-plugin/orders?status=pending", tone: "attention" },
    ] }],
  }),
});
// kind: "chart" — { unit: "won", points: [{ label: "9/30", value: 120000, sub: "3건" }], summary: [...] }
// kind: "list"  — { rows: [{ title, meta, value, badge, link }], empty: "아직 없습니다" }
```

`size: "half"` 인 판은 넓은 화면에서 둘이 나란히 섭니다. 카드와 같이 3초를 넘기거나 던지면 그 판만
오류로 보입니다. 칸의 `link` 는 **그 건들만** 보이는 목록이어야 합니다 — 목록 화면이 그 쿼리를
필터로 선언해야 주소에서 읽습니다(선언하지 않은 쿼리는 버립니다).
돈을 세는 판은 리포트와 **같은 함수**를 쓰세요. 두 화면의 매출이 다르면 아무도 믿지 않습니다.

## 화면의 CSS — 자기 것을 함께 내고, 값은 테마 토큰으로

블록이 그리는 HTML 의 CSS 는 **블록이 함께 냅니다**(`<style>` 를 HTML 에 붙여서). Tailwind
유틸리티 클래스에 기대지 마세요 — 서버는 빌드하지 않으므로, 나중에 설치된 확장의 클래스는
테마의 Tailwind 산출물에 없습니다. 남이 만든 테마가 Tailwind 를 안 쓸 수도 있습니다.

```ts
render: async () => `<div class="my-plugin-card">…</div>
<style>
.my-plugin-card{padding:16px;border:1px solid var(--color-line);border-radius:var(--radius-lg);
  background:var(--color-bg);color:var(--color-text)}
</style>`,
```

- **색·모서리·그림자·글꼴은 테마 토큰으로.** 쓸 수 있는 이름은 [테마 개발 가이드의 계약 토큰](theme-development.md#계약-토큰--빠뜨려도-코어가-채웁니다)
  입니다. 테마가 빠뜨려도 코어가 채우므로 폴백은 없어도 됩니다(달아 두면 테마 CSS 가 아예 없을 때의
  마지막 방어선이 됩니다). 계약에 없는 토큰 모양의 이름은 `check-theme-contract.mjs` 가 오타로 잡습니다.
- **같은 블록을 여러 번 놓아도 괜찮습니다.** 페이지를 조립할 때 내용이 완전히 같은 `<style>` 은 첫 것만
  남깁니다 — 블록이 "이미 냈는지" 를 기억할 필요가 없습니다. 반대로, 인스턴스마다 다른 값은 CSS 를 바꾸지
  말고 `style="--my-cols:3"` 처럼 **변수로** 넘기세요(CSS 가 같아야 하나로 합쳐집니다).
- **클래스 이름은 자기 접두어로.** 테마의 기본값은 `:where()` 로 특이도 0 이라 블록 클래스가 이깁니다.
  테마가 일부러 블록을 다시 그릴 때는 `.brick-main .my-plugin-card` 처럼 겨냥합니다.
- **모서리**는 `var(--radius)`·`var(--radius-lg)`(`check-radius-tokens`), **primary 위의 글자**는
  `var(--color-on-primary)`(`check-on-primary`), **배경을 정한 버튼은 hover 의 글자색도**(`check-button-hover`).
- **움직임은 동작 줄이기에서 끕니다** — `@media (prefers-reduced-motion: reduce)` 로 애니메이션을 `none` 으로.
  화면 위에 붙는(sticky) 요소는 `top: var(--brick-sticky-top, 0px)` 로 테마의 붙은 머리 아래에 둡니다.

## 구조

```
my-plugin/
├── brick.plugin.json     # manifest (필수)
├── dist/index.js         # 진입점 — 사전 빌드된 ESM (필수)
└── migrations/           # 플러그인 소유 테이블 (선택)
    └── 0001_init.sql
```

## manifest — brick.plugin.json

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "displayName": "내 플러그인",
  "description": "설명",
  "brickVersion": ">=0.0.1",
  "entry": "dist/index.js",
  "migrations": "migrations"
}
```

- `name`: 소문자/숫자/하이픈만. 전역 고유해야 하며 라우트/블록/테이블 네임스페이스가 됩니다.
- `entry`: dynamic import되는 ESM 파일. `activate(ctx)` 함수를 default export 해야 합니다.

## 진입점

```ts
import { definePlugin } from "@brick/plugin-sdk";

export default definePlugin((ctx) => {
  // REST API: /api/plugins/my-plugin/items/:id 로 마운트됨.
  // 마지막 인자(docs)는 선택 — /api/docs 의 API 문서에 한 줄 요약으로 실립니다.
  // 없어도 경로·메서드는 자동으로 문서에 실립니다.
  ctx.registerRoute("GET", "/items/:id", async (req) => {
    // req.params.id, req.query, req.body, req.user(세션 사용자 | null)
    return { id: req.params.id };
  });

  // 페이지 빌더 블록 — 서버 렌더(HTML 반환)이므로 검색엔진에 그대로 노출됩니다
  ctx.registerBlock({
    name: "my-block",            // 자동으로 "my-plugin/my-block"으로 네임스페이스됨
    displayName: "내 블록",
    propsSchema: { type: "object", properties: { text: { type: "string", title: "내용" } } },
    render: async (props) => `<p>${String(props.text ?? "")}</p>`,
  });
  // 안에 다른 블록을 담는 블록은 acceptsChildren: true 와 ctx.children — 배치 편집기가 그 안에 넣는 길을 연다
  // (docs/layout-editor.md 의 "플러그인 개발자")

  // 본인인증을 요구하는 기능이면 목적을 선언한다 — 관리자 → 본인인증 화면이 모아 보여 준다
  ctx.registerIdentityPurpose({
    key: "vip-room",
    label: "VIP 방 입장",                       // 원문이 번역 키 (locales/en.json)
    summary: async () => ({ count: 3, detail: ctx.t("identity.vipDetail"), manageUrl: "/admin/x/my-plugin/rooms" }),
  });

  // 훅: 코어/다른 플러그인의 이벤트 구독
  // 구독자는 **멱등** 이어야 한다 — 알린 쪽이 `doActionOrThrow` 로 다시 알릴 수 있다(결제완료 재처리 등).
  // `doAction` 은 구독자의 실패를 삼키고, `doActionOrThrow` 는 끝까지 돈 뒤 실패가 있으면 던진다.
  ctx.hooks.onAction("board.post.created", "my-plugin", async (payload) => { /* ... */ });

  // 관리자 메뉴
  ctx.registerAdminMenu({ label: "내 플러그인", path: "/admin/plugins/my-plugin" });

  return {
    deactivate: async () => { /* 타이머/구독 정리 */ },
  };
});
```

## 관리 화면 만들기 — 코드 없이

플러그인은 React 코드를 배포할 수 없습니다(Next.js는 빌드 타임에 라우트가 정해짐).
대신 **무엇을 편집할 수 있는지 선언**하면 코어 관리자가 목록·생성·수정·삭제 화면을
런타임에 만들어줍니다.

```ts
ctx.registerAdminResource({
  name: "items",              // /admin/x/my-plugin/items 로 접근
  title: "아이템",             // 사이드바·목록 제목
  itemLabel: "아이템",
  basePath: "/items",         // registerRoute로 등록한 REST 경로
  fields: [
    { name: "name",  label: "이름",   type: "text",  required: true, inList: true },
    { name: "price", label: "가격",   type: "money", inList: true },
    { name: "status", label: "상태",  type: "select", inList: true,
      options: [{ value: "on", label: "판매중" }, { value: "off", label: "중지" }] },
    { name: "body",  label: "설명",   type: "richtext" },
    { name: "hits",  label: "조회수", type: "number", readOnly: true, inList: true },
  ],
  can: { create: true, update: true, delete: false },
});
```

코어 관리자는 다음 규약으로 이 리소스의 API를 호출합니다 — `registerRoute`로 모두 등록해야 합니다:

| 메서드 | 경로 | 반환 |
|---|---|---|
| GET | `<basePath>?page=N` | `{ items, total, page, pageSize }` 또는 배열 |
| POST | `<basePath>` | 생성 |
| PUT | `<basePath>/:id` | 수정 |
| DELETE | `<basePath>/:id` | 삭제 |

### 일괄 작업 (bulkActions)

목록에서 여러 행을 골라 한 번에 처리해야 한다면(선택 삭제·이동·상태 변경)
`bulkActions` 를 선언하세요. 코어 관리 화면이 체크박스 열과 작업 막대를 그리고
`POST <basePath>/bulk` 로 `{ action, ids, params }` 를 보냅니다.

```ts
ctx.registerAdminResource({
  name: "posts", title: "게시글 관리", itemLabel: "게시글", basePath: "/admin/posts",
  fields: [...],
  bulkActions: [
    { code: "delete", label: "선택 삭제", destructive: true, confirm: "되돌릴 수 없습니다. 삭제할까요?" },
    { code: "move", label: "게시판 이동",
      input: { name: "board", label: "대상 게시판", optionsFrom: "/admin/boards/options" } },
  ],
});
ctx.registerRoute("POST", "/admin/posts/bulk", async (req) => {
  requireManager(req);                         // 권한은 라우트가 검사한다
  const { action, ids, params } = req.body as { action: string; ids: string[]; params?: Record<string, unknown> };
  // … 트랜잭션 안에서 처리하고 { ok: true, affected } 를 돌려준다
});
```

- `input.optionsFrom` 은 플러그인 라우트 경로입니다 — `[{ value, label }]` 을 돌려주세요.
- **배열 파라미터 주의**: `sql\`ANY(${ids}::uuid[])\`` 는 동작하지 않습니다(drizzle 이 배열을
  파라미터 나열로 풉니다). PG 배열 리터럴 문자열 `{"a","b"}` 로 만들어 하나의 파라미터로
  넘기세요(brick-board 의 `pgArray` 참고).

### 필드 타입

`text` · `textarea` · `richtext` · `number` · `money`(원 단위 표시) ·
`boolean` · `select` · `date` · `image`(미디어 URL + 미리보기)

`inList: true` 인 필드만 목록에 표시되고, `readOnly: true` 는 폼에서 제외됩니다.
목록의 `image` 칸은 맨 앞 열에 축소판으로 섭니다(폼의 칸 순서는 그대로).

레퍼런스: [plugins/brick-shop/src/admin-resources.ts](../plugins/brick-shop/src/admin-resources.ts) —
쇼핑몰이 이 방식으로 관리 화면 4개(주문·상품·분류·쿠폰)를 만듭니다.

## 트랜잭션 — 돈과 재고를 다룬다면 필수

`ctx.db.execute(sql\`BEGIN\`)` 를 **쓰면 안 됩니다.** 커넥션 풀에서 매 호출이
다른 커넥션을 받을 수 있어 트랜잭션이 성립하지 않습니다(조용히 깨집니다).

```ts
await ctx.db.transaction(async (tx) => {
  // 콜백 전체가 하나의 커넥션·하나의 트랜잭션에서 실행된다.
  // 예외를 던지면 전부 롤백된다.
  const { rows } = await tx.execute(sql`
    UPDATE items SET stock = stock - ${qty}
    WHERE id = ${id} AND stock >= ${qty}
    RETURNING id
  `);
  if (!rows.length) throw new HttpError(409, "재고가 부족합니다.");
  await tx.execute(sql`INSERT INTO orders ... `);
});
```

동시성이 있는 감소 연산은 **조회 후 차감이 아니라 조건부 UPDATE**로 해야 합니다.
위 예시의 `WHERE stock >= qty` + `RETURNING` 패턴이 그것입니다.

### PluginContext가 제공하는 것

| 항목 | 설명 |
|---|---|
| `ctx.db` | DB 핸들 — `execute()` 와 `transaction()` |
| `ctx.settings` | `plugin:<name>:` 네임스페이스가 적용된 설정 저장소 |
| `ctx.cache` / `ctx.queue` / `ctx.storage` | Provider 추상화 (지금 구현은 PostgreSQL·로컬 디스크뿐이다) |
| `ctx.lock` | 클러스터 전체에서 **한 번에 하나만** 돌아야 하는 일 — `withLock(키, fn)`, 잡혀 있으면 `null` |
| `ctx.rateLimit` | 요청 제한(비동기) — `consume`(원자적으로 세고 확인) · `check`(세지 않고 확인) · `hit` · `undo` · `reset`. 키는 플러그인별로 나뉜다. DB 에 세므로 서버가 여러 대여도 한도는 하나다 |
| `ctx.hooks` | action/filter 버스 |

### 주기 작업 — 사슬은 하나만, 실행은 한 번에 하나만

큐에는 반복 실행 기능이 없으므로, 작업이 끝에서 자기 다음 차례를 예약하는 **사슬**로
만듭니다. 쇼핑몰이 이 방식에서 두 번 사고를 냈습니다 — 그대로 따라 하면 같은 일이 납니다.

```ts
const JOB = "my-plugin.sweep";

ctx.queue.process(JOB, async () => {
  // (2) 겹쳐 돌지 않게 — 관리자의 "지금 실행" 버튼, 서버 두 대가 같은 순간에 돈다
  const result = await ctx.lock.withLock(`my-plugin:sweep`, () => sweep());
  if (result === null) ctx.logger.log("다른 곳에서 이미 돌고 있어 건너뜀");
  await ctx.queue.enqueue(JOB, {}, { delaySeconds: 600, dedupeKey: JOB });
}, {
  // (3) 끝내 실패하면 — "진행 중" 표시를 풀어야 운영자가 다시 시작할 수 있다
  onFailed: async (job, error) => { /* 상태를 '실패' 로 돌린다 */ },
});
// (1) 활성화할 때 사슬을 심는다 — dedupeKey 가 없으면 재시작할 때마다 사슬이 하나씩 는다
await ctx.queue.enqueue(JOB, {}, { delaySeconds: 60, dedupeKey: JOB });
```

1. **`dedupeKey`** — 같은 키로 대기 중인 작업은 하나만 남깁니다. 없으면 부팅할 때마다
   사슬이 하나씩 늘어 같은 일을 사슬 수만큼 되풀이합니다(개발 DB 에 넷이 겹쳐 있었습니다).
2. **`ctx.lock`** — 큐는 "한 작업을 한 워커가 집는다" 까지만 보장합니다. 정기결제 청구가
   겹쳤을 때 **카드는 긁혔는데 주문은 취소되고 환불도 없는** 결과가 났습니다
   ([architecture.md](architecture.md) ADR-71).
3. **`onFailed`** — 시도를 다 쓴 실패와, 마지막 시도 중 워커가 죽은 경우에 불립니다.
   뒤의 것은 핸들러 안의 try/catch 로는 알 수 없습니다. 끝내 실패한 작업은 관리자
   대시보드에도 경고로 뜹니다.

### 비회원 비밀번호 — `checkGuestSecret` 을 쓴다

비회원 글·문의처럼 **비밀번호 하나로 열리는 것**을 만든다면 직접 비교하지 말고 SDK 의
`checkGuestSecret` 을 거치게 하세요. 직접 비교하면 두 가지가 뚫립니다 — 한 대상에 1만 번(네
자리는 반드시 열린다), 여러 대상에 흔한 비밀번호 한 번씩(대상별 제한만으로는 못 막는다).

```ts
import { checkGuestSecret } from "@brick/plugin-sdk";

const ok = await checkGuestSecret(ctx.rateLimit, { target: `ticket:${id}`, ip: req.ip },
  () => verify(password, storedHash),               // 비동기 해시로 — scryptSync 는 서버 전체를 멈춘다
  () => new MyError(429, "비밀번호를 여러 번 틀렸습니다. 잠시 뒤 다시 시도해주세요."));
```

대상별·IP별로 **실패만** 세고, 검증 **전에** 세서 동시에 쏟아져도 한도만큼만 시험합니다.
비밀번호를 넣지 않은 요청(메일 링크를 처음 여는 순간)은 부르지 마세요 — 그것까지 세면
정당한 손님이 잠깁니다.

### 에러 → HTTP 상태코드

라우트 핸들러에서 `{ status: number }` 속성을 가진 에러를 던지면 해당 상태코드로 응답합니다:

```ts
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
if (!req.user) throw new HttpError(401, "login required");
```

에러에 `field` 속성을 붙이면 어느 입력 칸이 문제인지 화면에 함께 전달됩니다
(`{ statusCode, message, field }`). 긴 폼에서 손님을 그 칸으로 데려갈 수 있습니다.

**오류 문장도 사이트 언어를 따릅니다.** 선언 라벨과 같은 gettext 규칙입니다 —
**원문이 곧 카탈로그 키**이므로, 던지는 코드는 그대로 두고 `locales/en.json` 에
한 줄을 더하면 됩니다:

```json
{ "주문을 찾을 수 없습니다.": "Order not found." }
```

번역이 없으면 원문이 그대로 나갑니다. `field` 는 번역되지 않습니다 — 화면이
그 값으로 입력 칸을 찾기 때문입니다.

**값이 들어가는 문장은 카탈로그에서 꺼내 맞추세요.** 실행 시점 문자열이 코드의
리터럴과 달라 원문=키가 성립하지 않습니다:

```ts
// ❌ 번역되지 않는다
throw new MyError(400, `첨부는 최대 ${max}개까지 가능합니다.`);
// ✅
throw new MyError(400, ctx.t("err.tooManyFiles", { n: max }));
```

문장 **안의 낱말**도 같은 카탈로그를 타야 합니다. 상태 이름처럼 코드 안의
Record 로 사는 한국어를 그대로 끼우면 "You cannot change from 입금대기" 가
됩니다. 조사(`을/를`·`으로/로`)는 한국어의 문법이므로 한국어일 때만 붙이세요 —
영어 라벨에 붙으면 "Shipping으로" 가 됩니다.

`scripts/check-error-i18n.mjs` 가 번역이 빠진 오류 문장과 **값이 박힌 문장**을
CI 에서 잡습니다.

## 마이그레이션

- `migrations/*.sql` 파일이 파일명 순으로, 플러그인 **활성화 시점**에 1회씩 적용됩니다 (`plugin_migrations` 테이블로 멱등 보장).
- 테이블 이름에 반드시 플러그인 접두사를 붙이세요: `myplugin_items`.
- 기존 마이그레이션 파일은 수정하지 말고 새 파일을 추가하세요.

## 규칙 (중요)

1. **프로세스/포트를 직접 열지 마세요.** 모든 플러그인은 Brick 런타임 프로세스 안에서 실행됩니다.
2. **DB 커넥션을 직접 만들지 마세요.** `ctx.db`를 사용하세요.
3. **사용자 입력은 이스케이프하세요.** 블록 render가 반환한 HTML은 그대로 페이지에 삽입됩니다.
4. **원자성이 필요하면 `ctx.db.transaction()`을 쓰세요.** `execute("BEGIN")`은 동작하지 않습니다.
5. 네임스페이스 밖(다른 플러그인/코어 테이블)을 직접 수정하지 마세요. 훅으로 요청하세요.

## 배포

```bash
cd my-plugin
npm run build            # dist/ 생성 (Brick 서버가 아닌 개발자 머신에서)
zip -r my-plugin.zip brick.plugin.json dist migrations
```

관리자 → 플러그인 → 업로드 → 활성화. 끝.

레퍼런스 구현:
- [plugins/brick-board](../plugins/brick-board) — 게시판 (기본 패턴)
- [plugins/brick-shop](../plugins/brick-shop) — 쇼핑몰 (관리자 리소스, 트랜잭션, 재고 동시성)

---

## 개인정보를 저장한다면 (필수)

플러그인이 회원과 연결된 데이터를 저장하면 **삭제 방법을 등록해야 합니다.**
등록하지 않으면 회원이 탈퇴한 뒤에도 그 데이터가 남아 **위법 상태**가 됩니다.
코어는 여러분의 테이블 이름을 알 수 없으므로 대신 지워줄 수 없습니다 (ADR-38).

```ts
ctx.registerDataEraser({
  label: "내 플러그인",
  order: 50,                       // 작을수록 먼저 (기본 100)
  async erase({ tx, userId, deletePosts }) {
    // 반드시 넘어온 tx 를 쓴다 — ctx.db 는 트랜잭션 밖으로 나간다
    const { rows } = await tx.execute(sql`
      DELETE FROM my_table WHERE user_id = ${userId}::uuid RETURNING id
    `);
    return rows.length ? [`기록 ${rows.length}건 삭제`] : [];
  },
  // 되돌릴 수 없는 손실은 반드시 미리 알린다
  async describe({ userId }) {
    return [{ label: "내 기록", detail: "N건이 삭제되며 복구할 수 없습니다." }];
  },
});
```

**지킬 것 세 가지**

1. **넘어온 `tx` 를 쓴다.** `ctx.db` 를 쓰면 트랜잭션 밖으로 나가고,
   "데이터는 지웠는데 계정 익명화가 실패해 되돌아간" 상태가 가능해집니다.
2. **예외를 삼키지 않는다.** 실패하면 탈퇴 전체가 되돌아가는 것이 맞습니다 —
   지우지 못한 것을 지웠다고 말하지 않기 위해서입니다. 훅(action)과 반대입니다.
3. **지울지 익명화할지 판단한다.** 법정 보존 의무가 있는 데이터(거래 기록)는
   지우면 안 됩니다. 그 판단은 도메인을 아는 여러분이 해야 합니다.
   판단 기준은 [회원 생애주기 문서](members.md)에 정리해두었습니다.

**되돌릴 수 없는 일은 `afterCommit` 으로 미룹니다.** 저장소의 파일 지우기, 다른 플러그인에 알리기(포인트 회수 같은
훅)는 트랜잭션 안에서 하면 탈퇴가 되돌아갔을 때 이미 일어나 있습니다. `erase` 가 받는 `afterCommit(fn)` 에 맡기면
탈퇴가 **커밋된 뒤에** 실행됩니다. 거기서 던진 예외는 기록만 하고 탈퇴를 되돌리지 않습니다(이미 끝났습니다).

```ts
async erase({ tx, userId, afterCommit }) {
  const { rows } = await tx.execute(sql`DELETE FROM my_files WHERE user_id = ${userId}::uuid RETURNING storage_key`);
  afterCommit(async () => { for (const r of rows) await ctx.storage.delete(String(r.storage_key)); });
  return [`파일 ${rows.length}건 삭제`];
}
```

동작 확인은 `scripts/smoke-member.sh` 를 참고하세요 — "파기했다"는 응답을 믿지 않고
DB의 실제 행을 들여다봅니다.

## 사용자가 넣은 주소를 화면에 싣는다면 (`publicUrl`)

후기 사진·문의 첨부·글 썸네일·공유 이미지처럼 **사용자·운영자가 넣은 주소**를 `<img src>` · `<meta content>` · 사이트맵에
실을 때는 직접 정규식을 쓰지 말고 `@brick/plugin-sdk` 의 함수를 쓰세요.

```ts
import { publicUrl, publicUrls, toAbsoluteUrl } from "@brick/plugin-sdk";

publicUrl("/uploads/a.png");            // "/uploads/a.png"
publicUrl("//evil.test/x.png");         // null — 프로토콜 상대 주소: 보는 사람의 브라우저가 남의 서버를 부른다
publicUrl("javascript:alert(1)");       // null
publicUrls(input.images, { max: 5 });   // 실어도 되는 것만, 같은 것은 한 번, 5개까지
toAbsoluteUrl("/uploads/a.png", ctx.site.url);   // og:image·사이트맵은 절대 주소여야 한다
```

규칙 하나: `http(s)://호스트…`(대소문자 무관) 또는 `/` 로 시작하는 **사이트 안 경로**. `//…`, `\` 가 든 것,
공백·제어문자가 든 것(사이트맵 XML 을 깨뜨린다), 그 밖의 스킴은 거절합니다. 이 규칙이 여섯 곳에 넷으로 갈라져 적혀 있던
때는 후기·문의 첨부·반품 사진·글 썸네일이 `//남의도메인/x.png` 를 통과시켰습니다. 거르는 것은 "실어도 되는가" 까지이고
이스케이프는 싣는 자리(`escapeHtml`)의 몫입니다. 규칙은 `scripts/check-public-url.mjs` 가 못박습니다.

## 공개 URL을 만든다면

게시글·상품처럼 **공개 주소를 만드는** 플러그인은 사이트맵에 등록하세요.
코어는 `pages` 테이블만 알기 때문에, 등록하지 않으면 검색엔진이 그 주소를
찾지 못합니다 (ADR-40).

```ts
ctx.registerSitemapSource({
  label: "내 콘텐츠",
  count: async () => /* 전체 개수 */,
  page: async ({ offset, limit }) => /* 그 구간의 URL */,
});
```

**정렬을 안정적으로.** `created_at, id` 처럼 변하지 않는 순서를 쓰세요 —
페이지를 나눠 읽는 동안 순서가 바뀌면 어떤 URL은 두 번 나오고 어떤 URL은 빠집니다.

**비공개 콘텐츠를 빼세요.** 권한이 필요한 주소가 사이트맵에 들어가면
검색 결과에 노출되고, 그 자체가 유출입니다.

**사진이 있으면 `images` 로 함께 주세요** — 구글 이미지 검색이 사이트맵의 `<image:image>` 로 찾습니다
(상품 사진이 이미지 검색에 오르는 길). http(s) 나 `/` 로 시작하는 것만 싣고(`/uploads/…` 는 절대 주소로
바뀝니다) 주소마다 10장까지입니다. 사이트맵은 **보는 사람을 모르는** 통로이므로, 주소는 공개여도 사진은
가려야 하는 것(성인 상품)은 넘기지 마세요.

자세한 내용은 [문의·FAQ·SEO 문서](helpdesk.md)에 있습니다.


## 원클릭 업데이트 배포하기

사용자가 관리자 화면에서 버튼 하나로 새 버전을 받게 하려면:

### 1. 키 만들기 (한 번만)

```bash
node scripts/sign-extension.mjs keygen --out my-key
```

`my-key.private.pem` 은 **비밀**입니다. 잃으면 기존 사용자에게 업데이트를
보낼 수 없습니다 (사용자가 새 ZIP 을 직접 올려야 합니다).

### 2. 매니페스트에 넣기

```json
{
  "name": "my-plugin",
  "publisherKey": "<my-key.public.txt 내용>",
  "updates": "https://example.com/my-plugin.update.json"
}
```

`updates` 는 **https** 여야 합니다.

### 3. 새 버전을 서명해서 올리기

```bash
node scripts/sign-extension.mjs sign \
  --zip my-plugin-1.2.0.zip \
  --key my-key.private.pem \
  --url https://example.com/my-plugin-1.2.0.zip \
  --notes "버그 수정" \
  --out my-plugin.update.json
```

ZIP 과 `my-plugin.update.json` 을 서버에 올리면 끝입니다. 사용자의
"업데이트 확인"이 그 JSON 을 읽습니다.

### 지켜지는 것

- 사용자가 **처음 설치할 때** 공개키가 고정됩니다. 이후 다른 키로 서명한
  ZIP 은 서버가 뚫려도 설치되지 않습니다.
- 버전은 semver 숫자 비교입니다. 낮은 버전은 업데이트로 제시되지 않습니다.
- ZIP 은 50MB 상한입니다.

## 레지스트리에 올리기

레지스트리는 중앙 서버가 아니라 **정적 JSON** 입니다. 운영자의 관리 화면이
그 목록을 읽고, 항목이 가리키는 업데이트 매니페스트(위 절의 그 JSON)로
설치합니다 — 설치와 업데이트가 같은 서명 검증을 지납니다.

공식 레지스트리(`docs-site/registry.json`)에 등재하려면 저장소에 PR 로
항목을 추가하세요:

```json
{
  "kind": "plugin",
  "name": "my-plugin",
  "displayName": "내 플러그인",
  "description": "한 줄 소개",
  "version": "1.0.0",
  "updates": "https://내서버/my-plugin.update.json",
  "publisherKey": "<my-key.public.txt 의 내용>",
  "homepage": "https://github.com/me/my-plugin"
}
```

레지스트리는 목록일 뿐 신뢰의 근거가 아닙니다 — 설치를 결정하는 것은
매니페스트의 서명입니다. 회사 내부 레지스트리를 쓰려면 같은 형식의 JSON 을
아무 곳(https)에나 올리고 관리자 설정의 `extensions.registry_url` 을
바꾸면 됩니다.

## 이미지를 받는다면 `ctx.images` 를 거치세요

손님이 올리는 사진은 4000px·4MB 입니다. 그대로 저장하면 목록 한 화면이 수십 MB 가 되고,
EXIF 의 촬영 위치(GPS)까지 공개됩니다. 코어가 자기 미디어에 쓰는 것과 같은 처리를 플러그인도
쓸 수 있습니다.

```ts
ctx.registerRoute("POST", "/photos", async (req) => {
  const [file] = await req.files();
  if (!ctx.images.canProcess(file.contentType)) throw new Error("이미지만");

  // 원본을 줄이고 EXIF 를 지운다. ext 가 null 이면 형식이 그대로다
  const opt = await ctx.images.optimize(file.buffer, file.contentType, { maxWidth: 1600 });
  const key = `photos/${id}${opt.ext ?? extOf(file.fileName)}`;
  await ctx.storage.put(key, opt.buffer, opt.contentType);

  // 목록을 그린다면 썸네일도 함께 (정사각 WebP)
  const thumb = await ctx.images.thumbnail(file.buffer, file.contentType);
  if (thumb) await ctx.storage.put(`photos/${id}-thumb${thumb.ext}`, thumb.buffer, thumb.contentType);

  return { url: ctx.storage.publicUrl(key), width: opt.width, height: opt.height };
});
```

처리 수단(sharp)이 없는 환경에서는 **원본을 그대로 돌려줍니다** — 업로드가 막히지 않습니다.
GIF·SVG 는 애니메이션·벡터를 잃지 않도록 건드리지 않으므로 `canProcess()` 가 false 입니다.

### 운영자가 고른 사진을 목록에 그릴 때

관리 화면에서 미디어에서 고른 사진은 **원본** 주소입니다. 그것을 목록의 작은 칸에 그대로
그리면 안 됩니다 — 실측으로 원본 2.0MB, 썸네일 8.3KB(247배)였고, 상품 24개가 깔린 첫
화면이 50MB 가 됩니다.

```ts
// 저장할 때 한 번 찾아 함께 적어 둡니다 (조회할 때마다 찾으면 화면마다 질의가 붙습니다)
const thumbUrl = await ctx.images.thumbUrlFor(imageUrl);   // 없으면 null
// 목록 질의: coalesce(thumb_url, image_url) — 없으면 원본을 쓰므로 화면은 깨지지 않습니다
```

`null` 이 되는 경우는 셋입니다: 운영자가 외부 URL 을 직접 붙였다, 썸네일이 없는 형식이다
(GIF·SVG), `sharp` 가 없는 환경에서 올린 사진이다. **주소 규칙을 직접 짐작하지 마세요**
("/uploads/ 를 떼면 키") — 스토리지가 S3 로 바뀌면 그 짐작을 전부 찾아다녀야 합니다.

**관리 화면에는 편집 원본을 주세요.** 목록 API 가 썸네일을 내려주면 그 화면에서 상품을
저장하는 순간 원본 자리에 썸네일이 박히고, 상세의 큰 사진이 흐려집니다(실제로 그랬습니다).
목록의 작은 미리보기를 위해 편집 값을 오염시킬 수는 없습니다.

사진이 여러 장이면 필드 타입을 `images` 로 선언하세요 — 화면이 미디어에서 여러 장을 한 번에
고르게 하고 순서를 바꾸게 합니다. 값은 여전히 "한 줄에 주소 하나"이므로 서버 파싱은 그대로
씁니다.

```ts
{ name: "images_text", label: "추가 이미지", type: "images", max: 20 }
```

## 실시간 알림 개수 (로그인한 회원의 화면)

로그인한 회원에게 그려지는 화면에는 머리의 알림 링크(`a[href="/notifications"]`) 개수를 서버가 밀어 주는 값으로 바꾸는
작은 스크립트가 붙습니다 (`GET /api/notifications/stream`, SSE). 테마·플러그인이 할 일은 없습니다.

- 링크에 이미 그려진 문구("알림 3" · "Alerts 3")의 **끝 숫자만** 바꿉니다 — 언어와 마크업(아이콘·`span`)을 따라갑니다.
- 개수가 바뀔 때마다 문서에 `brick:notifications` 이벤트가 나갑니다. 화면 안의 다른 요소(예: 탭 제목)가 반응하려면 듣기만 하세요:
  `document.addEventListener("brick:notifications", (e) => console.log(e.detail.unread))`
- 알림을 만들 때는 지금처럼 `NotificationsService.notify` 만 부르면 됩니다. 같은 프로세스에서는 곧바로, 다른 프로세스에서는 5초 안에 닿습니다.
- 스크립트가 없거나 실패해도 화면은 그대로입니다(점진적 향상). 연결은 회원당 4개, 15분마다 새로 붙습니다 — 로그아웃·세션 폐기가 열린 연결에 닿지 않기 때문입니다.
