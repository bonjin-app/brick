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
    /**
     * draft | scheduled | published | archived
     *
     * `scheduled` 는 "published_at 이 되면 공개한다" 는 뜻이다 — 그때까지는
     * published 가 아니므로 손님·검색·사이트맵 어디에도 나오지 않는다.
     */
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    seo: jsonb("seo").notNull().default({}), // { title, description, ogImage, noindex }
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * 공개 시각.
     *
     * `published` 면 **공개된 순간**, `scheduled` 면 **공개할 순간**이다.
     * 한 칸이 두 뜻을 갖는 것이 아니라 같은 뜻이다 — 이 페이지가 세상에 나오는 때.
     */
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

/**
 * 페이지 이전 버전.
 *
 * 저장할 때마다 그때 저장한 내용을 한 판 남긴다 — 덮어쓴 뒤에 잘못을 알아채도
 * 되돌릴 수 있게. (packages/database/migrations/0014_page_revisions.sql 에 이유를 적어 두었다)
 */
export const pageRevisions = pgTable(
  "page_revisions",
  {
    id: uuid("id").primaryKey(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    /** 페이지 안에서의 판 번호 (1부터) — 시각이 아니라 번호로 부른다 */
    revNo: integer("rev_no").notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    /** 그때의 주소. 되돌릴 때 쓰지는 않는다(링크가 끊긴다) */
    slug: varchar("slug", { length: 255 }).notNull(),
    blocks: jsonb("blocks").notNull().default([]),
    seo: jsonb("seo").notNull().default({}),
    /** 그때의 공개 상태. 되돌릴 때 쓰지 않는다 */
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    note: varchar("note", { length: 200 }).notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("page_revisions_no_uniq").on(t.pageId, t.revNo),
    index("page_revisions_page_idx").on(t.pageId, t.revNo),
  ],
);
