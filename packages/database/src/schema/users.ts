import { pgTable, uuid, varchar, text, timestamp, boolean, index, smallint } from "drizzle-orm/pg-core";

/** 회원. 비밀번호는 argon2id 해시만 저장 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    displayName: varchar("display_name", { length: 100 }).notNull(),
    role: varchar("role", { length: 20 }).notNull().default("member"), // admin | manager | member
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    /**
     * 비밀번호로 로그인할 수 있는가.
     * 소셜 전용 계정은 false — 비밀번호 로그인과 재설정 메일을 모두 막는다
     * (재설정으로 비밀번호를 만들어 소셜 연결을 우회하는 경로를 닫는다).
     */
    passwordLoginEnabled: boolean("password_login_enabled").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    /** 만 14세 이상 확인 — 미만은 법정대리인 동의 절차가 필요하다 */
    ageConfirmed: boolean("age_confirmed").notNull().default(true),
    /** 광고성 정보 수신 동의 (선택). 단체 메일 발송이 이 값을 존중해야 한다 */
    marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
    /**
     * 생일 (선택 · 월/일만 — 연도는 받지 않는다: 최소수집).
     * 회원이 마이페이지에서 스스로 입력하고 언제든 지운다. 탈퇴 시 파기.
     */
    birthMonth: smallint("birth_month"),
    birthDay: smallint("birth_day"),
    /** 프로필 이미지(스토리지 공개 URL). 없으면 화면이 이니셜 원을 그린다 */
    avatarUrl: text("avatar_url"),
    /** 마지막으로 표시 이름을 바꾼 시각 — 변경 주기(member.nick_change_days) 판정 */
    displayNameChangedAt: timestamp("display_name_changed_at", { withTimezone: true }),
    /** 마지막 로그인 — 휴면 판정의 기준 */
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** 휴면 전환 시점. NULL 이면 정상 계정 */
    dormantAt: timestamp("dormant_at", { withTimezone: true }),
    /**
     * 탈퇴 시점. NULL 이면 탈퇴하지 않은 계정.
     * 탈퇴는 행 삭제가 아니라 익명화다 — 주문은 법정 보존 대상이므로
     * CASCADE 로 지워지면 안 된다 (WithdrawalService).
     */
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawReason: varchar("withdraw_reason", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("users_role_idx").on(t.role)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * 비밀번호 재설정 토큰.
 * 세션과 같은 원칙: 토큰 원문은 메일 링크에만 있고 DB에는 sha256 해시만 둔다.
 * usedAt으로 단회성을 보장한다 (재사용 공격 차단).
 */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    requestedIp: varchar("requested_ip", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("password_resets_user_idx").on(t.userId)],
);
