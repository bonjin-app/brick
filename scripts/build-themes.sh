#!/usr/bin/env bash
# 동봉 테마의 Tailwind 소스(src/style.css)를 assets/style.css 로 컴파일한다.
#
# 런타임(서버·ZIP 설치)은 빌드가 없다 — 컴파일 결과를 저장소에 함께 커밋한다.
# CI 는 이 스크립트를 돌린 뒤 `git diff --exit-code themes/*/assets` 로 소스와 산출물이
# 어긋나지 않았는지 본다 (소스만 고치고 컴파일을 잊는 실수를 막는다).
#
#   scripts/build-themes.sh            # 전부
#   scripts/build-themes.sh editorial  # 하나
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TW="$ROOT/node_modules/.bin/tailwindcss"
[[ -x "$TW" ]] || { echo "tailwindcss CLI 가 없습니다 — pnpm install"; exit 1; }
for DIR in "$ROOT"/themes/*/; do
  NAME="$(basename "$DIR")"
  [[ -n "${1:-}" && "$1" != "$NAME" ]] && continue
  [[ -f "$DIR/src/style.css" ]] || continue
  "$TW" -i "$DIR/src/style.css" -o "$DIR/assets/style.css" --minify >/dev/null 2>&1 \
    || { echo "❌ $NAME 컴파일 실패"; "$TW" -i "$DIR/src/style.css" -o "$DIR/assets/style.css" --minify; exit 1; }
  echo "✅ $NAME → assets/style.css ($(wc -c < "$DIR/assets/style.css") bytes)"
done
