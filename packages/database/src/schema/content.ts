import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

/**
 * 페이지/문서 — 페이지 빌더의 저장 단위.
 * blocks: 페이지 빌더 트리(JSONB). 각 노드 = { block: "board/latest-posts", props: {...}, children: [...] }
 * PostgreSQL FTS(tsvector generated column)로 전문 검색을 코어에서 지원한다.
 */
export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey(),
    slug: varchar("slug", { length: 255 }).notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    blocks: jsonb("blocks").notNull().default([]),
    /** SEO: 렌더된 본문 텍스트 캐시 (검색 색인용) */
    plainText: text("plain_text").notNull().default(""),
    status: varchar("status", { length: 20 }).notNull().default("draft"), // draft | published | archived
    seo: jsonb("seo").notNull().default({}), // { title, description, ogImage, noindex }
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pages_slug_idx").on(t.slug),
    index("pages_status_idx").on(t.status),
    // 한국어 대응은 simple + pg_bigm/pg_trgm 확장 조합으로 시작 (mecab 계열은 선택)
    index("pages_fts_idx").using("gin", sql`to_tsvector('simple', ${t.title} || ' ' || ${t.plainText})`),
  ],
);

/** 메뉴 (관리자가 편집하는 내비게이션) */
export const menus = pgTable("menus", {
  id: uuid("id").primaryKey(),
  location: varchar("location", { length: 50 }).notNull(), // header | footer | ...
  items: jsonb("items").notNull().default([]), // [{ label, url, children }]
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 업로드 파일 메타데이터 (실제 바이트는 StorageProvider가 관리) */
export const mediaFiles = pgTable(
  "media_files",
  {
    id: uuid("id").primaryKey(),
    storageKey: text("storage_key").notNull().unique(),
    fileName: varchar("file_name", { length: 500 }).notNull(),
    contentType: varchar("content_type", { length: 200 }).notNull(),
    size: varchar("size", { length: 20 }).notNull(),
    /** 이미지 치수 — 업로드 시 읽어 둔다. 이미지가 아니거나 처리 못 했으면 NULL */
    width: integer("width"),
    height: integer("height"),
    /** 목록용 정사각 WebP 썸네일의 저장 키. NULL 이면 화면이 원본을 쓴다 */
    thumbKey: text("thumb_key"),
    uploaderId: uuid("uploader_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("media_uploader_idx").on(t.uploaderId)],
);
