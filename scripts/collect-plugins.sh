#!/usr/bin/env bash
#
# 동봉할 플러그인을 모은다.
#
# 왜 스크립트인가:
#   플러그인 목록이 build-release.sh 와 docker/Dockerfile 에 따로 하드코딩되어
#   있었다. 플러그인을 추가할 때마다 두 곳을 함께 고쳐야 했고, 실제로 셋 다
#   서로 다른 목록을 갖게 됐다 — Docker 이미지에는 게시판 하나만,
#   배포본에는 셋만 들어가서 쇼핑몰·포인트·쪽지가 빠진 설치본이 나갔다.
#
#   그래서 목록을 없앤다. **빌드된 플러그인은 전부 동봉한다.**
#   조건은 두 개뿐이다: brick.plugin.json 이 있고, dist/index.js 가 빌드되어 있다.
#   활성화는 관리자가 결정하므로 동봉이 곧 활성화는 아니다 —
#   빠져 있으면 설치할 방법이 없지만, 들어 있으면 켜기만 하면 된다.
#
# 런타임에 필요한 것만 담는다: 매니페스트 · dist · migrations.
# src / node_modules / tsconfig 는 담지 않는다 (node_modules 는 pnpm 심볼릭
# 링크라 복사하면 깨진다).
#
# 사용법: bash scripts/collect-plugins.sh <대상 디렉터리>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:?사용법: collect-plugins.sh <대상 디렉터리>}"

mkdir -p "$DEST"
count=0
skipped=()

for dir in "$ROOT"/plugins/*/; do
  name="$(basename "$dir")"

  if [[ ! -f "$dir/brick.plugin.json" ]]; then
    skipped+=("$name (brick.plugin.json 없음)")
    continue
  fi
  if [[ ! -f "$dir/dist/index.js" ]]; then
    # 빌드하지 않고 배포본을 만들면 조용히 빠지는 대신 여기서 드러난다
    skipped+=("$name (dist/index.js 없음 — pnpm build 먼저)")
    continue
  fi

  mkdir -p "$DEST/$name"
  cp "$dir/brick.plugin.json" "$DEST/$name/"
  [[ -f "$dir/package.json" ]] && cp "$dir/package.json" "$DEST/$name/"
  cp -R "$dir/dist" "$DEST/$name/dist"
  [[ -d "$dir/migrations" ]] && cp -R "$dir/migrations" "$DEST/$name/migrations"

  echo "   + $name"
  count=$((count + 1))
done

if [[ ${#skipped[@]} -gt 0 ]]; then
  echo "   빠짐:"
  printf '     - %s\n' "${skipped[@]}"
fi

[[ $count -gt 0 ]] || { echo "동봉할 플러그인이 없습니다. pnpm build 를 먼저 실행하세요." >&2; exit 1; }
echo "   플러그인 ${count}개"
