#!/usr/bin/env node
/**
 * 확장 서명 도구 — 배포자가 쓴다.
 *
 * Brick 의 원클릭 업데이트는 **처음 설치할 때 고정된 배포자 키**의 서명이
 * 있는 ZIP 만 받는다. 이 도구가 그 서명을 만든다.
 *
 * 사용법:
 *   # 1. 키 쌍 만들기 (한 번만. 개인키를 잃으면 기존 사용자에게 업데이트를
 *   #    보낼 수 없다 — 안전하게 보관할 것)
 *   node scripts/sign-extension.mjs keygen --out my-key
 *   #    → my-key.private.pem (비밀!) · my-key.public.txt (매니페스트에 넣는 값)
 *
 *   # 2. 매니페스트(brick.plugin.json)에 넣기
 *   #    "publisherKey": "<my-key.public.txt 내용>",
 *   #    "updates": "https://example.com/my-plugin.update.json"
 *
 *   # 3. ZIP 서명 → 업데이트 매니페스트 생성
 *   node scripts/sign-extension.mjs sign \
 *     --zip my-plugin-1.2.0.zip \
 *     --key my-key.private.pem \
 *     --url https://example.com/my-plugin-1.2.0.zip \
 *     --notes "버그 수정" \
 *     --out my-plugin.update.json
 *
 * Ed25519 를 쓰는 이유: 키가 짧고(32바이트), node:crypto 에 내장되어 있어
 * 외부 의존성이 없고, 서명·검증이 빠르다. 인증 경로의 의존성은 공급망
 * 위험이다 (TOTP 를 직접 구현한 것과 같은 판단 — ADR-55).
 */
import { generateKeyPairSync, createHash, sign as edSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const command = process.argv[2];

if (command === "keygen") {
  const out = arg("out", "brick-publisher");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  writeFileSync(`${out}.private.pem`, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

  // 공개키는 SPKI DER 의 마지막 32바이트가 raw 키다 — 매니페스트에는
  // raw base64 를 넣는다 (짧고, 형식 협상이 필요 없다)
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 32);
  writeFileSync(`${out}.public.txt`, raw.toString("base64") + "\n");

  console.log(`개인키: ${out}.private.pem  (비밀 — 잃으면 기존 사용자에게 업데이트를 못 보냅니다)`);
  console.log(`공개키: ${out}.public.txt  (brick.plugin.json 의 "publisherKey" 에 넣는 값)`);
  process.exit(0);
}

if (command === "sign") {
  const zipPath = arg("zip");
  const keyPath = arg("key");
  const url = arg("url");
  if (!zipPath || !keyPath || !url) {
    console.error("사용법: sign --zip <파일> --key <개인키.pem> --url <다운로드 주소> [--notes <요약>] [--out <파일>]");
    process.exit(1);
  }

  const zip = readFileSync(zipPath);
  const privateKey = readFileSync(keyPath, "utf8");

  // ZIP 안의 매니페스트에서 이름·버전을 읽는다 — 손으로 두 번 적으면 어긋난다.
  // yauzl 없이 최소한으로: End of Central Directory 를 뒤져 로컬 헤더를 읽는
  // 대신, 압축 안 된 매니페스트를 가정하지 않고 unzip 유틸에 기대지도 않는다.
  // 대신 --name/--version 으로 받되, 없으면 파일명에서 추정한다.
  let name = arg("name", "");
  let version = arg("version", "");
  if (!name || !version) {
    // my-plugin-1.2.0.zip → name: my-plugin, version: 1.2.0
    const m = /^(.+)-(\d+\.\d+\.\d+[^.]*)\.zip$/.exec(basename(zipPath));
    if (m) {
      name = name || m[1];
      version = version || m[2];
    }
  }
  if (!name || !version) {
    console.error("이름·버전을 파일명에서 알 수 없습니다. --name 과 --version 을 지정해주세요.");
    process.exit(1);
  }

  const signature = edSign(null, zip, privateKey).toString("base64");
  const sha256 = createHash("sha256").update(zip).digest("hex");

  const manifest = {
    name,
    version,
    url,
    sha256,
    signature,
    ...(arg("notes") ? { notes: arg("notes") } : {}),
  };

  const outPath = arg("out", `${name}.update.json`);
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`업데이트 매니페스트: ${outPath}`);
  console.log(`  ${name}@${version} · sha256 ${sha256.slice(0, 12)}…`);
  console.log("이 파일과 ZIP 을 서버에 올리고, 매니페스트 주소를 확장의 \"updates\" 에 넣으세요.");
  process.exit(0);
}

console.error("사용법: sign-extension.mjs <keygen|sign> [옵션]");
process.exit(1);
