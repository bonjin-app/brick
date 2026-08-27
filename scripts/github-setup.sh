#!/usr/bin/env bash
#
# GitHub 저장소 메타데이터 설정.
#
# 저장소 설명(About) · 토픽 · 기능 스위치는 **파일이 아니라 GitHub 설정**이라
# 커밋으로는 바뀌지 않는다. 그래서 의도한 값을 여기 적어두고 한 번에 적용한다.
# 웹에서 손으로 바꾸면 "어떤 설명이 맞는 설명인지"가 저장소에 남지 않는다.
#
# 필요한 것: gh CLI (brew install gh) 그리고 `gh auth login`
# 사용법:
#   bash scripts/github-setup.sh            # 적용
#   bash scripts/github-setup.sh --dry-run  # 무엇이 바뀌는지만 보기
set -euo pipefail

REPO="${BRICK_REPO:-bonjin-app/brick}"
HOMEPAGE="https://bonjin-app.github.io/brick/"

# 90자 안쪽으로 — 목록과 고정(pin) 카드에서 잘리지 않는 길이다.
# "무엇인지 + 무엇으로 만들었는지" 순서로 적는다.
DESCRIPTION="설치는 그누보드처럼 쉽게, 속은 현대적으로. Docker 한 줄 또는 FTP 업로드로 설치하는 오픈소스 CMS — Next.js + NestJS + PostgreSQL"

# 토픽은 검색 유입 경로다. 영어(국제 검색) + 한국 생태계 키워드를 섞는다.
TOPICS=(
  cms
  headless-cms
  nextjs
  nestjs
  postgresql
  typescript
  monorepo
  self-hosted
  plugin-architecture
  ecommerce
  forum
  korean
  gnuboard
  open-source-cms
  docker
)

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

command -v gh >/dev/null 2>&1 || {
  cat >&2 <<'MSG'
gh CLI가 필요합니다.

  brew install gh && gh auth login

설치하지 않고 웹에서 직접 하려면:
  Settings → General 에서 Description / Website
  저장소 첫 화면 우측 About 의 ⚙ 에서 Topics
MSG
  exit 1
}

echo "▶ 대상: $REPO"

if $DRY_RUN; then
  echo
  echo "설명:"
  echo "  $DESCRIPTION"
  echo "홈페이지:"
  echo "  $HOMEPAGE"
  echo "토픽:"
  printf '  %s\n' "${TOPICS[@]}"
  echo
  echo "현재 값:"
  gh api "repos/$REPO" \
    --jq '{description, homepage, topics, has_issues, has_discussions, has_wiki, has_projects}'
  exit 0
fi

echo "── 설명 · 홈페이지"
gh api -X PATCH "repos/$REPO" \
  -f description="$DESCRIPTION" \
  -f homepage="$HOMEPAGE" \
  --silent

echo "── 토픽"
# names[] 를 통째로 보내므로 이 목록이 곧 최종 상태다
TOPIC_ARGS=()
for t in "${TOPICS[@]}"; do TOPIC_ARGS+=(-f "names[]=$t"); done
gh api -X PUT "repos/$REPO/topics" "${TOPIC_ARGS[@]}" --silent

echo "── 기능 스위치"
# Wiki와 Projects는 쓰지 않는다 — 비어 있는 탭은 "관리되지 않는 프로젝트"로 읽힌다.
# 문서는 docs/ 에, 논의는 Discussions에 둔다.
gh api -X PATCH "repos/$REPO" \
  -F has_issues=true \
  -F has_wiki=false \
  -F has_projects=false \
  -F delete_branch_on_merge=true \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  --silent

echo "── GitHub Pages (랜딩페이지)"
# 워크플로(.github/workflows/pages.yml)는 이미 있지만, Pages의 소스를
# "GitHub Actions" 로 지정하지 않으면 배포가 시작되지 않고 홈페이지가 404가 된다.
# 이미 켜져 있으면 PUT, 아니면 POST — 둘 다 시도한다.
if gh api "repos/$REPO/pages" --silent >/dev/null 2>&1; then
  gh api -X PUT "repos/$REPO/pages" -f build_type=workflow --silent
  echo "   기존 설정을 Actions 빌드로 맞췄습니다."
else
  gh api -X POST "repos/$REPO/pages" -f build_type=workflow --silent
  echo "   Pages를 켰습니다. 첫 배포는 pages 워크플로를 한 번 돌려야 합니다:"
  echo "     gh workflow run pages.yml --repo $REPO"
fi

echo "── 취약점 경고 · 자동 보안 수정"
gh api -X PUT "repos/$REPO/vulnerability-alerts" --silent 2>/dev/null || true
gh api -X PUT "repos/$REPO/automated-security-fixes" --silent 2>/dev/null || true

echo
echo "✅ 적용했습니다."
echo
cat <<MSG
웹에서만 되는 나머지 두 가지:

1) 소셜 미리보기 이미지
   bash scripts/make-social-preview.sh
   → Settings → General → Social preview → Upload an image
     (.github/assets/social-preview.png)

2) Discussions 켜기 (이슈 템플릿이 링크로 안내합니다)
   → Settings → General → Features → Discussions
   API로는 켤 수 없습니다.

3) 랜딩페이지 첫 배포
   gh workflow run pages.yml --repo $REPO
   → https://bonjin-app.github.io/brick/ 확인
MSG
