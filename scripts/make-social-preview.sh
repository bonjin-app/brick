#!/usr/bin/env bash
#
# 소셜 미리보기 이미지(PNG) 생성.
#
# GitHub의 Social preview 설정은 PNG/JPG만 받으므로
# .github/assets/social-preview.svg 를 1280×640 PNG로 굽는다.
#
# 변환기가 여러 개 있을 수 있는데, 하나만 골라 강제하면 그게 없는 기계에서
# 아무것도 못 하게 된다. 있는 것을 순서대로 시도한다.
#
# 사용법: bash scripts/make-social-preview.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/.github/assets/social-preview.svg"
OUT="$ROOT/.github/assets/social-preview.png"
W=1280
H=640

[[ -f "$SRC" ]] || { echo "원본이 없습니다: $SRC" >&2; exit 1; }

render_with_chrome() {
  local chrome="$1"
  # --screenshot 은 화면 크기를 그대로 쓰므로 window-size 를 정확히 맞춘다.
  # --default-background-color=0 은 투명 배경 (SVG가 배경을 그리므로 무해)
  "$chrome" --headless --disable-gpu --no-sandbox \
    --hide-scrollbars --force-device-scale-factor=1 \
    --window-size="${W},${H}" \
    --screenshot="$OUT" "file://$SRC" >/dev/null 2>&1
}

if command -v rsvg-convert >/dev/null 2>&1; then
  echo "▶ rsvg-convert 로 변환"
  rsvg-convert -w "$W" -h "$H" -o "$OUT" "$SRC"
elif command -v magick >/dev/null 2>&1; then
  echo "▶ ImageMagick 으로 변환"
  magick -background none -density 144 "$SRC" -resize "${W}x${H}" "$OUT"
elif command -v inkscape >/dev/null 2>&1; then
  echo "▶ Inkscape 로 변환"
  inkscape "$SRC" --export-type=png --export-filename="$OUT" \
    --export-width="$W" --export-height="$H" >/dev/null
elif [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  echo "▶ Chrome(헤드리스) 으로 변환"
  render_with_chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif command -v chromium >/dev/null 2>&1; then
  echo "▶ Chromium(헤드리스) 으로 변환"
  render_with_chrome "$(command -v chromium)"
else
  cat >&2 <<'MSG'
변환기를 찾지 못했습니다. 아래 중 하나를 설치하세요:

  brew install librsvg          # rsvg-convert (가장 가볍습니다)
  brew install imagemagick

또는 SVG를 아무 편집기에서 열어 1280×640 PNG로 내보내세요:
  .github/assets/social-preview.svg
MSG
  exit 1
fi

[[ -s "$OUT" ]] || { echo "변환에 실패했습니다 (빈 파일)" >&2; exit 1; }

echo "✅ $OUT"
echo
echo "GitHub에 올리는 방법 (API로는 올릴 수 없어 웹에서만 됩니다):"
echo "  Settings → General → Social preview → Edit → Upload an image"
