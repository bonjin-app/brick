# 소셜 로그인

구글 · 카카오 · 네이버 · GitHub, 그리고 사내 SSO(표준 OpenID Connect)로 로그인합니다.
플러그인이 아니라 **코어 기능**입니다 — 로그인은 사이트의 관문이고, 플러그인이
비활성화되어 로그인이 사라지는 상황을 만들 수 없습니다.

## 설정하기

1. 공급자의 개발자 콘솔에서 앱(클라이언트)을 만듭니다.
2. Brick 관리자 → **설정** → 소셜 로그인에서 Client ID와 Client Secret을 넣습니다.
3. 같은 화면에 표시된 **Redirect URI**를 공급자 콘솔에 그대로 등록합니다.
4. 체크박스를 켜고 저장하면 로그인·회원가입 화면에 버튼이 나타납니다.

Redirect URI는 `BRICK_SITE_URL` 을 기준으로 만들어집니다:

```
<사이트 주소>/api/auth/oauth/<공급자>/callback
```

사이트 주소를 바꾸면 공급자 콘솔의 등록 주소도 함께 바꿔야 합니다.
운영에서는 `https://` 여야 합니다 — 공급자 대부분이 http를 거부합니다.

Client Secret은 저장 후 **다시 볼 수 없습니다**. 사용 여부나 Client ID만 바꿀 때는
Secret 칸을 비워두면 기존 값이 유지됩니다.

### 공급자별 발급 위치

| 공급자 | 콘솔 | 비고 |
|---|---|---|
| Google | Google Cloud Console → API 및 서비스 → 사용자 인증 정보 | OAuth 2.0 클라이언트 ID (웹) |
| 카카오 | Kakao Developers → 내 애플리케이션 | 카카오 로그인 활성화 + 동의항목에서 이메일 설정 |
| 네이버 | 네이버 개발자센터 → 애플리케이션 등록 | 서비스 URL과 Callback URL 모두 등록 |
| GitHub | Settings → Developer settings → OAuth Apps | Authorization callback URL |

### 사내 SSO (표준 OpenID Connect)

Keycloak · Authentik · Azure AD · Okta 등 표준 OIDC를 말하는 서버는 **SSO** 항목에
주소 세 개를 직접 넣어 연결합니다. 공급자의
`/.well-known/openid-configuration` 에서 찾을 수 있습니다.

| 설정 | OIDC 문서의 이름 |
|---|---|
| 인증 주소 | `authorization_endpoint` |
| 토큰 주소 | `token_endpoint` |
| 사용자 정보 주소 | `userinfo_endpoint` |

`sub` · `email` · `email_verified` · `name` 클레임을 사용합니다.

## 로그인하면 무슨 일이 일어나는가

```
1) 이미 연결된 신원인가?          → 그 회원으로 로그인
2) 검증된 이메일이 기존 회원과 같은가? → 그 회원에 연결하고 로그인
3) 그 외                          → 새 회원을 만들고 로그인
```

## 설계에서 중요한 것

로그인은 틀리면 **계정을 잃는** 영역입니다. 다음을 명시적으로 방어합니다.

### 1. 검증된 이메일만 기존 계정에 붙인다

공급자가 이메일 소유를 확인하지 않았다면, 공격자가 남의 이메일을 적어둔 소셜
계정으로 그 사람의 Brick 계정에 들어올 수 있습니다.

그래서 `email_verified` 가 참일 때만 기존 계정에 연결합니다. 검증되지 않은
이메일이 기존 계정과 겹치면 **연결하지 않고** "로그인한 뒤 내 정보에서
연결해주세요"라고 안내합니다.

GitHub는 `/user` 응답의 이메일이 검증된 것인지 알 수 없으므로 항상 미검증으로
다룹니다. 카카오는 `is_email_verified` 와 `is_email_valid` 가 **모두** 참일 때만
신뢰합니다.

### 2. state를 쿠키에 묶는다

state를 서명만 하면, 공격자가 자기 흐름에서 받은 state를 남의 브라우저에 심어
**그 사람을 공격자의 계정으로 로그인시킬** 수 있습니다(로그인 CSRF). 그 상태로
피해자가 결제하거나 글을 쓰면 공격자의 계정에 남습니다.

그래서 인증을 시작할 때 state를 쿠키에도 심고, 콜백에서 쿼리의 state와 쿠키가
같은지 봅니다. 쿠키는 `HttpOnly` 이고 경로는 `/api/auth/oauth` 로 좁힙니다.

state 자체는 서버에 저장하지 않습니다 — HMAC 서명 + 10분 만료입니다.
서버를 재시작해도 진행 중인 로그인이 깨지지 않습니다.

### 3. 소셜 전용 계정에는 비밀번호 경로를 닫는다

소셜로 가입한 계정은 `password_login_enabled = false` 입니다.

- 비밀번호 로그인이 **거부**됩니다. 다만 응답은 일반적인 인증 실패와 같습니다 —
  "이 이메일은 소셜 계정입니다"라고 알려주면 가입 여부가 새어 나갑니다.
- 비밀번호 **재설정 메일도 나가지 않습니다.** 재설정으로 비밀번호를 만들면
  소셜 연결을 우회해 들어올 수 있습니다.

`password_hash` 를 NULL 허용으로 바꾸지 않았습니다. 소셜 전용 계정에도 쓸 수 없는
무작위 해시를 넣습니다 — NULL을 허용하면 "비밀번호 없는 계정"이라는 상태가
인증 코드 전체에 퍼지고, 한 곳만 검사를 빠뜨려도 비밀번호 없이 로그인됩니다.

### 4. 마지막 로그인 수단은 해제할 수 없다

비밀번호 로그인이 꺼진 계정에서 소셜이 하나뿐이면 연결 해제를 거부합니다(409).
허용하면 계정에 들어갈 방법이 사라지고, 관리자가 DB를 직접 만지지 않으면
복구할 수 없습니다.

### 5. 이메일이 없어도 로그인된다

카카오는 이메일이 **선택 동의**입니다. 동의하지 않은 사용자를 막으면 상당수가
가입을 포기합니다. 그래서 이메일이 없으면 `<공급자>_<uid>@social.invalid` 로
내부 주소를 만들어 계정을 만듭니다. `.invalid` 는 예약된 TLD라 실제로 메일이
나가지 않습니다 — 나중에 사용자가 이메일을 채우면 정상 주소로 바꿉니다.

### 6. 돌아갈 경로는 내부만 허용한다

`?next=` 는 state 안에 서명되어 들어가지만, 값 자체는 검사합니다.
`/` 로 시작하지 않거나 `//` 로 시작하는 값(브라우저가 프로토콜 상대 URL로 읽어
외부로 나갑니다), 제어문자가 섞인 값은 모두 `/` 로 접습니다.

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/auth/oauth/providers` | 사용 가능한 공급자 (로그인 화면용) |
| GET | `/api/auth/oauth/:provider?next=&link=` | 인증 시작 → 공급자로 302 |
| GET | `/api/auth/oauth/:provider/callback` | 콜백 → 세션 발급 후 `next` 로 302 |
| GET | `/api/auth/oauth/my/identities` | 내 소셜 연결 목록 |
| DELETE | `/api/auth/oauth/my/identities/:provider` | 연결 해제 |
| GET | `/api/auth/oauth/admin/providers` | 공급자 설정 (관리자) |
| PUT | `/api/auth/oauth/admin/providers/:provider` | 공급자 설정 저장 (관리자) |

`link=1` 은 **연결** 흐름입니다 — 이미 로그인한 사람이 소셜을 추가로 붙일 때
쓰고, 비로그인 상태에서는 401입니다.

## 훅

| 훅 | 시점 |
|---|---|
| `user.registered` | 소셜로 **새 계정**이 만들어질 때 (가입 축하 포인트가 여기에 붙습니다) |
| `auth.login` | 소셜 로그인 성공 시 (출석 적립 등) |

비밀번호 가입·로그인과 같은 훅을 씁니다. 적립 정책을 두 번 쓰지 않아도 됩니다.

## 감사 로그

`auth.oauth_signup` · `auth.oauth_login` · `auth.oauth_failed` ·
`auth.oauth_unlink` · `auth.oauth_config` 가 행위자·IP와 함께 기록됩니다.
실패 기록에는 사유가 함께 남아, 설정이 잘못된 것과 공격 시도를 구분할 수 있습니다.

## 테스트

실제 공급자에 붙어 테스트할 수 없으므로 표준 OIDC 스텁을 씁니다:

```bash
DATABASE_URL=postgresql://brick:brick@localhost:5432/brick bash scripts/smoke-social.sh
```

스텁([scripts/oidc-stub.mjs](../scripts/oidc-stub.mjs))이 인증·토큰·프로필
엔드포인트를 흉내내고, Brick의 `oidc` 공급자로 연결해 흐름 전체를 검증합니다 —
state 쿠키 결속, 코드 1회성, 계정 생성·연결, 정지 계정 차단, 우회 경로까지 76개
항목입니다. 스텁이 표준 OIDC를 그대로 말하므로, 여기서 통과하면 실제 OIDC
공급자에서도 같은 경로로 동작합니다.

## 아직 없는 것

PKCE, 애플 로그인(client_secret이 JWT라 별도 서명이 필요합니다),
공급자 토큰 저장·갱신(Brick은 로그인에만 쓰고 공급자 API를 대신 호출하지 않습니다),
관리자 화면에서의 회원별 연결 관리.
