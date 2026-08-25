import { Injectable, OnModuleInit } from "@nestjs/common";
import { PluginLoaderService } from "../plugins/plugin-loader.service.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * 코어 블록 — 플러그인 없이 기본 제공되는 페이지 빌더 재료.
 * "core/" 네임스페이스는 예약되어 있으며 비활성화되지 않는다.
 */
@Injectable()
export class CoreBlocksService implements OnModuleInit {
  constructor(private readonly loader: PluginLoaderService) {}

  onModuleInit(): void {
    const b = this.loader.blocks;

    b.set("core/heading", {
      name: "core/heading",
      displayName: "제목",
      propsSchema: {
        type: "object",
        properties: {
          text: { type: "string", title: "내용" },
          level: { type: "number", title: "크기 (1-3)", default: 2 },
        },
      },
      render: async (props) => {
        const level = Math.min(3, Math.max(1, Number(props.level ?? 2)));
        return `<h${level}>${esc(props.text)}</h${level}>`;
      },
    });

    b.set("core/paragraph", {
      name: "core/paragraph",
      displayName: "문단",
      propsSchema: {
        type: "object",
        properties: { text: { type: "string", title: "내용", format: "multiline" } },
      },
      render: async (props) => `<p>${esc(props.text).replace(/\n/g, "<br />")}</p>`,
    });

    b.set("core/rich-text", {
      name: "core/rich-text",
      displayName: "HTML",
      propsSchema: {
        type: "object",
        properties: { html: { type: "string", title: "HTML", format: "multiline" } },
      },
      // 관리자만 페이지를 편집할 수 있으므로 raw HTML을 신뢰한다 (WordPress custom HTML 블록과 동일한 신뢰 모델)
      render: async (props) => String(props.html ?? ""),
    });

    b.set("core/image", {
      name: "core/image",
      displayName: "이미지",
      propsSchema: {
        type: "object",
        properties: {
          src: { type: "string", title: "이미지 URL" },
          alt: { type: "string", title: "대체 텍스트" },
        },
      },
      render: async (props) =>
        `<figure><img src="${esc(props.src)}" alt="${esc(props.alt)}" style="max-width:100%" /></figure>`,
    });

    b.set("core/columns", {
      name: "core/columns",
      displayName: "다단 레이아웃",
      acceptsChildren: true,
      propsSchema: {
        type: "object",
        properties: { gap: { type: "number", title: "간격(px)", default: 24 } },
      },
      render: async (props, children = []) => {
        const gap = Number(props.gap ?? 24);
        const cells = children.map((c) => `<div>${c}</div>`).join("");
        return `<div style="display:grid;grid-template-columns:repeat(${children.length || 1},1fr);gap:${gap}px">${cells}</div>`;
      },
    });

    b.set("core/spacer", {
      name: "core/spacer",
      displayName: "여백",
      propsSchema: {
        type: "object",
        properties: { height: { type: "number", title: "높이(px)", default: 40 } },
      },
      render: async (props) => `<div style="height:${Number(props.height ?? 40)}px"></div>`,
    });
  }
}
