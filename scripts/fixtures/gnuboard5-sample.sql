-- 그누보드5 덤프 픽스처 (테스트용).
--
-- phpMyAdmin 내보내기와 같은 형태로 만들었다. 파서가 실제 데이터에서 깨지는
-- 지점을 일부러 넣어두었다:
--   - 게시글 본문에 `),(` 와 `\'` 와 줄바꿈(\n)
--   - 컬럼 목록을 생략한 INSERT (CREATE TABLE 순서를 알아야 한다)
--   - '0000-00-00 00:00:00' (MySQL 의 유효하지 않은 날짜)
--   - 이메일이 없는 회원, 이메일이 겹치는 회원
--   - bcrypt($2y$) · 구형 MD5 · 알 수 없는 형식의 비밀번호
--   - 여러 행을 한 INSERT 에 넣은 것과 한 행씩 넣은 것
--   - 원글이 없는 고아 댓글
--
-- 비밀번호는 모두 'password' 다:
--   bcrypt: $2y$10$... (PHP password_hash() 와 같은 형식)
--   MD5:    5f4dcc3b5aa765d61d8327deb882cf99 = md5('password')
-- 스모크가 이 값으로 "그누보드 비밀번호가 그대로 통한다"를 검증한다.
-- 해시를 바꾸면 scripts/smoke-migrate.sh 의 로그인 검증이 깨진다.

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET time_zone = "+00:00";

-- ─────────────────────────────────────────────────────
CREATE TABLE `g5_member` (
  `mb_no` int(11) NOT NULL AUTO_INCREMENT,
  `mb_id` varchar(20) NOT NULL DEFAULT '',
  `mb_password` varchar(255) NOT NULL DEFAULT '',
  `mb_name` varchar(255) NOT NULL DEFAULT '',
  `mb_nick` varchar(255) NOT NULL DEFAULT '',
  `mb_email` varchar(255) NOT NULL DEFAULT '',
  `mb_level` tinyint(4) NOT NULL DEFAULT '1',
  `mb_point` int(11) NOT NULL DEFAULT '0',
  `mb_datetime` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  `mb_leave_date` varchar(8) NOT NULL DEFAULT '',
  PRIMARY KEY (`mb_no`),
  UNIQUE KEY `mb_id` (`mb_id`),
  KEY `mb_email` (`mb_email`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- 컬럼 목록을 생략한 INSERT (phpMyAdmin 기본 설정 중 하나)
INSERT INTO `g5_member` VALUES
(1,'admin','$2y$10$FyKjLYbhECExcucxc5w07.YoOgJlpiz2.txzyuE/uSyj45TSlffZ.','관리자','최고관리자','admin@old.test',10,5000,'2015-03-01 09:00:00',''),
(2,'staff','$2y$10$FyKjLYbhECExcucxc5w07.YoOgJlpiz2.txzyuE/uSyj45TSlffZ.','운영자','운영','staff@old.test',8,1200,'2016-07-15 14:30:00',''),
(3,'hong','5f4dcc3b5aa765d61d8327deb882cf99','홍길동','길동','hong@old.test',2,300,'2018-01-20 11:00:00',''),
(4,'noemail','5f4dcc3b5aa765d61d8327deb882cf99','이메일없음','무명','',2,0,'2019-05-05 08:00:00','');

-- 한 행씩 넣은 INSERT + 컬럼 목록을 명시한 형태
INSERT INTO `g5_member` (`mb_no`,`mb_id`,`mb_password`,`mb_name`,`mb_nick`,`mb_email`,`mb_level`,`mb_point`,`mb_datetime`,`mb_leave_date`) VALUES
(5,'dup','5f4dcc3b5aa765d61d8327deb882cf99','중복','중복회원','hong@old.test',2,0,'2020-02-02 02:02:02','');
INSERT INTO `g5_member` (`mb_no`,`mb_id`,`mb_password`,`mb_name`,`mb_nick`,`mb_email`,`mb_level`,`mb_point`,`mb_datetime`,`mb_leave_date`) VALUES
(6,'weird','plaintext-not-a-hash','이상한','이상','weird@old.test',2,0,'0000-00-00 00:00:00','');
INSERT INTO `g5_member` (`mb_no`,`mb_id`,`mb_password`,`mb_name`,`mb_nick`,`mb_email`,`mb_level`,`mb_point`,`mb_datetime`,`mb_leave_date`) VALUES
(7,'left','5f4dcc3b5aa765d61d8327deb882cf99','탈퇴자','떠남','left@old.test',1,0,'2017-01-01 00:00:00','20210301');

-- ─────────────────────────────────────────────────────
CREATE TABLE `g5_board` (
  `bo_table` varchar(20) NOT NULL DEFAULT '',
  `gr_id` varchar(255) NOT NULL DEFAULT '',
  `bo_subject` varchar(255) NOT NULL DEFAULT '',
  `bo_content_head` text NOT NULL,
  `bo_read_level` tinyint(4) NOT NULL DEFAULT '1',
  `bo_write_level` tinyint(4) NOT NULL DEFAULT '1',
  `bo_comment_level` tinyint(4) NOT NULL DEFAULT '1',
  `bo_download_level` tinyint(4) NOT NULL DEFAULT '1',
  `bo_page_rows` int(11) NOT NULL DEFAULT '0',
  `bo_use_reply` tinyint(4) NOT NULL DEFAULT '0',
  `bo_use_secret` tinyint(4) NOT NULL DEFAULT '0',
  `bo_upload_count` tinyint(4) NOT NULL DEFAULT '0',
  PRIMARY KEY (`bo_table`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

INSERT INTO `g5_board` VALUES
('notice','community','공지사항','공지 안내입니다',1,10,2,2,15,0,0,2),
('free','community','자유게시판','',1,2,2,2,20,1,1,2),
('secret_room','community','비밀게시판','',8,8,8,8,20,0,1,0),
('empty','community','글없는게시판','',1,2,2,2,20,0,0,0);

-- ─────────────────────────────────────────────────────
CREATE TABLE `g5_write_notice` (
  `wr_id` int(11) NOT NULL AUTO_INCREMENT,
  `wr_num` int(11) NOT NULL DEFAULT '0',
  `wr_reply` varchar(10) NOT NULL DEFAULT '',
  `wr_parent` int(11) NOT NULL DEFAULT '0',
  `wr_is_comment` tinyint(4) NOT NULL DEFAULT '0',
  `wr_comment` int(11) NOT NULL DEFAULT '0',
  `ca_name` varchar(255) NOT NULL DEFAULT '',
  `wr_option` set('html1','html2','secret','mail') NOT NULL,
  `wr_subject` varchar(255) NOT NULL DEFAULT '',
  `wr_content` text NOT NULL,
  `wr_datetime` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  `wr_hit` int(11) NOT NULL DEFAULT '0',
  `wr_good` int(11) NOT NULL DEFAULT '0',
  `mb_id` varchar(20) NOT NULL DEFAULT '',
  `wr_name` varchar(255) NOT NULL DEFAULT '',
  PRIMARY KEY (`wr_id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

INSERT INTO `g5_write_notice` VALUES
(1,1,'',1,0,1,'안내','html1','사이트 이용 안내','<p>안녕하세요.</p><p>이용 규칙을 안내합니다.</p>','2020-03-01 10:00:00',1523,12,'admin','최고관리자'),
(2,2,'',2,0,0,'','','줄바꿈이 있는 평문 공지','첫째 줄입니다.\n둘째 줄입니다.\n\n빈 줄 뒤 넷째 줄.','2020-04-01 11:00:00',88,0,'admin','최고관리자'),
(3,1,'A',1,1,0,'','','','댓글입니다. 괄호와 쉼표가 들어 있습니다 — 예: (1,2),(3,4)','2020-03-02 09:00:00',0,0,'hong','길동'),
(4,1,'B',1,1,0,'','','','따옴표 테스트: It\'s a test, isn\'t it? 그리고 \"큰따옴표\"도.','2020-03-03 09:00:00',0,0,'hong','길동'),
(5,3,'',999,1,0,'','','','원글이 없는 고아 댓글 — 버려져야 한다','2020-03-04 09:00:00',0,0,'hong','길동');

-- ─────────────────────────────────────────────────────
CREATE TABLE `g5_write_free` (
  `wr_id` int(11) NOT NULL AUTO_INCREMENT,
  `wr_num` int(11) NOT NULL DEFAULT '0',
  `wr_reply` varchar(10) NOT NULL DEFAULT '',
  `wr_parent` int(11) NOT NULL DEFAULT '0',
  `wr_is_comment` tinyint(4) NOT NULL DEFAULT '0',
  `wr_comment` int(11) NOT NULL DEFAULT '0',
  `ca_name` varchar(255) NOT NULL DEFAULT '',
  `wr_option` set('html1','html2','secret','mail') NOT NULL,
  `wr_subject` varchar(255) NOT NULL DEFAULT '',
  `wr_content` text NOT NULL,
  `wr_datetime` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  `wr_hit` int(11) NOT NULL DEFAULT '0',
  `wr_good` int(11) NOT NULL DEFAULT '0',
  `mb_id` varchar(20) NOT NULL DEFAULT '',
  `wr_name` varchar(255) NOT NULL DEFAULT '',
  PRIMARY KEY (`wr_id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

INSERT INTO `g5_write_free` VALUES
(1,1,'',1,0,0,'잡담','','비회원이 쓴 글','비회원 글입니다.','2021-06-01 12:00:00',5,0,'','손님'),
(2,2,'',2,0,0,'','secret','비밀글입니다','비밀 내용','2021-06-02 12:00:00',3,0,'hong','길동'),
(3,3,'',3,0,0,'','','날짜가 이상한 글','0000-00-00 날짜를 가진 글','0000-00-00 00:00:00',0,0,'hong','길동');

-- 글 테이블이 없는 게시판(empty)은 게시판만 만들어져야 한다

-- ─────────────────────────────────────────────────────
CREATE TABLE `g5_point` (
  `po_id` int(11) NOT NULL AUTO_INCREMENT,
  `mb_id` varchar(20) NOT NULL DEFAULT '',
  `po_datetime` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  `po_content` varchar(255) NOT NULL DEFAULT '',
  `po_point` int(11) NOT NULL DEFAULT '0',
  `po_use_point` int(11) NOT NULL DEFAULT '0',
  `po_expired` tinyint(4) NOT NULL DEFAULT '0',
  PRIMARY KEY (`po_id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

INSERT INTO `g5_point` VALUES
(1,'admin','2020-01-01 00:00:00','회원가입 축하',1000,0,0),
(2,'admin','2020-02-01 00:00:00','글쓰기',100,0,0),
(3,'admin','2020-03-01 00:00:00','상품 구매 사용',-300,300,0),
(4,'hong','2020-01-01 00:00:00','회원가입 축하',1000,0,0),
(5,'hong','2020-05-01 00:00:00','전액 사용',-1000,1000,0),
(6,'staff','2020-01-01 00:00:00','회원가입 축하',500,0,0);

-- ─────────────────────────────────────────────────────
-- 옮기지 않는 테이블들 — analyze 가 "안 옮긴다"고 알려야 한다
CREATE TABLE `g5_memo` (
  `me_id` int(11) NOT NULL AUTO_INCREMENT,
  `me_recv_mb_id` varchar(20) NOT NULL DEFAULT '',
  `me_memo` text NOT NULL,
  PRIMARY KEY (`me_id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE `g5_poll` (
  `po_id` int(11) NOT NULL AUTO_INCREMENT,
  `po_subject` varchar(255) NOT NULL DEFAULT '',
  PRIMARY KEY (`po_id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE `g5_visit` (
  `vi_id` int(11) NOT NULL AUTO_INCREMENT,
  `vi_ip` varchar(255) NOT NULL DEFAULT '',
  PRIMARY KEY (`vi_id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

INSERT INTO `g5_visit` VALUES (1,'203.0.113.45');

-- ═════════════════════════════════════════════════════
-- 영카트5 (쇼핑몰) — 같은 접두어를 쓴다
--
-- 파서와 매핑이 실제 데이터에서 깨지는 지점을 넣어두었다:
--   - 계층 분류 (ca_id 앞자리가 부모)
--   - 한글만으로 된 상품명 (slug 를 만들 수 없다)
--   - it_use=0 (판매 중지) · it_soldout=1 (품절)
--   - 구버전 우편번호 (od_zip1 + od_zip2)
--   - 알 수 없는 주문 상태
--   - 주문되지 않은 장바구니 행 (od_id 가 빈 값)
--   - 금액이 맞지 않는 주문 (할인으로 흡수해야 한다)
-- ═════════════════════════════════════════════════════

CREATE TABLE `g5_shop_category` (
  `ca_id` varchar(10) NOT NULL DEFAULT '',
  `ca_name` varchar(255) NOT NULL DEFAULT '',
  `ca_order` int(11) NOT NULL DEFAULT '0',
  `ca_use` tinyint(4) NOT NULL DEFAULT '0',
  PRIMARY KEY (`ca_id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

INSERT INTO `g5_shop_category` VALUES
('10','의류',1,1),
('1010','상의',1,1),
('1020','하의',2,1),
('20','신발',2,1),
('30','숨긴분류',3,0);

CREATE TABLE `g5_shop_item` (
  `it_id` varchar(20) NOT NULL DEFAULT '',
  `ca_id` varchar(10) NOT NULL DEFAULT '',
  `it_name` varchar(255) NOT NULL DEFAULT '',
  `it_basic` varchar(255) NOT NULL DEFAULT '',
  `it_explan` text NOT NULL,
  `it_price` int(11) NOT NULL DEFAULT '0',
  `it_cust_price` int(11) NOT NULL DEFAULT '0',
  `it_stock_qty` int(11) NOT NULL DEFAULT '0',
  `it_use` tinyint(4) NOT NULL DEFAULT '0',
  `it_soldout` tinyint(4) NOT NULL DEFAULT '0',
  `it_sc_type` tinyint(4) NOT NULL DEFAULT '0',
  `it_order` int(11) NOT NULL DEFAULT '0',
  `it_hit` int(11) NOT NULL DEFAULT '0',
  `it_img1` varchar(255) NOT NULL DEFAULT '',
  `it_img2` varchar(255) NOT NULL DEFAULT '',
  `it_time` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  PRIMARY KEY (`it_id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

INSERT INTO `g5_shop_item` VALUES
('20200101120000','1010','기본 티셔츠','편안한 면 티셔츠','<p>100% 면입니다.</p>',19000,25000,50,1,0,0,1,342,'tshirt1.jpg','tshirt2.jpg','2020-01-01 12:00:00'),
('20200202130000','1020','청바지','',  '',39000,0,0,1,1,0,2,120,'jeans.jpg','','2020-02-02 13:00:00'),
('20200303140000','20','운동화','가벼운 러닝화','설명',89000,99000,10,1,0,2,3,88,'','','2020-03-03 14:00:00'),
('20200404150000','10','단종된 상품','','',10000,0,0,0,0,0,4,5,'','','2020-04-04 15:00:00');

CREATE TABLE `g5_shop_item_option` (
  `io_no` int(11) NOT NULL AUTO_INCREMENT,
  `it_id` varchar(20) NOT NULL DEFAULT '',
  `io_id` varchar(255) NOT NULL DEFAULT '',
  `io_price` int(11) NOT NULL DEFAULT '0',
  `io_stock_qty` int(11) NOT NULL DEFAULT '0',
  `io_use` tinyint(4) NOT NULL DEFAULT '0',
  PRIMARY KEY (`io_no`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

INSERT INTO `g5_shop_item_option` VALUES
(1,'20200101120000','흰색,S',0,20,1),
(2,'20200101120000','흰색,M',0,15,1),
(3,'20200101120000','검정,L',1000,5,1),
(4,'20200101120000','사용안함',0,0,0);

CREATE TABLE `g5_shop_order` (
  `od_id` varchar(20) NOT NULL DEFAULT '',
  `mb_id` varchar(20) NOT NULL DEFAULT '',
  `od_name` varchar(255) NOT NULL DEFAULT '',
  `od_email` varchar(255) NOT NULL DEFAULT '',
  `od_tel` varchar(255) NOT NULL DEFAULT '',
  `od_hp` varchar(255) NOT NULL DEFAULT '',
  `od_zip1` varchar(3) NOT NULL DEFAULT '',
  `od_zip2` varchar(3) NOT NULL DEFAULT '',
  `od_addr1` varchar(255) NOT NULL DEFAULT '',
  `od_addr2` varchar(255) NOT NULL DEFAULT '',
  `od_addr3` varchar(255) NOT NULL DEFAULT '',
  `od_b_name` varchar(255) NOT NULL DEFAULT '',
  `od_b_tel` varchar(255) NOT NULL DEFAULT '',
  `od_memo` text NOT NULL,
  `od_cart_price` int(11) NOT NULL DEFAULT '0',
  `od_send_cost` int(11) NOT NULL DEFAULT '0',
  `od_receipt_price` int(11) NOT NULL DEFAULT '0',
  `od_settle_case` varchar(255) NOT NULL DEFAULT '',
  `od_status` varchar(255) NOT NULL DEFAULT '',
  `od_time` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  PRIMARY KEY (`od_id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

INSERT INTO `g5_shop_order` VALUES
('20210601-0000001','hong','홍길동','hong@old.test','02-111-2222','010-1111-2222','063','000','서울시 강남구','101동 202호','문앞','홍길동','010-1111-2222','부재시 경비실',19000,3000,22000,'카드','완료','2021-06-01 10:00:00'),
('20210602-0000002','admin','관리자','admin@old.test','','010-9999-8888','','','제주시 어딘가','','','받는사람','010-7777-6666','',39000,5000,44000,'무통장','입금','2021-06-02 11:00:00'),
('20210603-0000003','','비회원손님','guest@x.test','','010-3333-4444','12345','','부산시','','','비회원손님','010-3333-4444','',89000,0,85000,'가상계좌','배송','2021-06-03 12:00:00'),
('20210604-0000004','hong','홍길동','hong@old.test','','010-1111-2222','','','서울시','','','홍길동','010-1111-2222','',19000,3000,22000,'카드','취소','2021-06-04 13:00:00'),
('20210605-0000005','hong','홍길동','hong@old.test','','010-1111-2222','','','서울시','','','홍길동','010-1111-2222','',19000,3000,22000,'카드','이상한상태','2021-06-05 14:00:00');

CREATE TABLE `g5_shop_cart` (
  `ct_id` int(11) NOT NULL AUTO_INCREMENT,
  `od_id` varchar(20) NOT NULL DEFAULT '',
  `mb_id` varchar(20) NOT NULL DEFAULT '',
  `it_id` varchar(20) NOT NULL DEFAULT '',
  `it_name` varchar(255) NOT NULL DEFAULT '',
  `ct_price` int(11) NOT NULL DEFAULT '0',
  `ct_qty` int(11) NOT NULL DEFAULT '0',
  `ct_option` varchar(255) NOT NULL DEFAULT '',
  `io_price` int(11) NOT NULL DEFAULT '0',
  `ct_status` varchar(255) NOT NULL DEFAULT '',
  PRIMARY KEY (`ct_id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

INSERT INTO `g5_shop_cart` VALUES
(1,'20210601-0000001','hong','20200101120000','기본 티셔츠',19000,1,'흰색,M',0,'완료'),
(2,'20210602-0000002','admin','20200202130000','청바지',39000,1,'',0,'입금'),
(3,'20210603-0000003','','20200303140000','운동화',89000,1,'',0,'배송'),
(4,'20210604-0000004','hong','20200101120000','기본 티셔츠',19000,1,'검정,L',1000,'취소'),
(5,'20210605-0000005','hong','20200101120000','기본 티셔츠',19000,1,'',0,'이상한상태'),
(6,'','hong','20200101120000','기본 티셔츠',19000,2,'',0,'쇼핑');

-- 옮기지 않는 것들 (analyze 가 알려줘야 한다)
CREATE TABLE `g5_shop_item_use` (
  `is_id` int(11) NOT NULL AUTO_INCREMENT,
  `it_id` varchar(20) NOT NULL DEFAULT '',
  `is_content` text NOT NULL,
  PRIMARY KEY (`is_id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE `g5_shop_item_qa` (
  `iq_id` int(11) NOT NULL AUTO_INCREMENT,
  `it_id` varchar(20) NOT NULL DEFAULT '',
  `iq_question` text NOT NULL,
  PRIMARY KEY (`iq_id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;
