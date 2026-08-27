import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller.js";
import { MembersModule } from "../members/members.module.js";

// 가입은 약관 동의 없이 완료될 수 없으므로 MembersModule 의 서비스를 쓴다
@Module({ imports: [MembersModule], controllers: [UsersController] })
export class UsersModule {}
