import { Module } from '@nestjs/common'
import { ApiController } from './api.controller.js'
import { AdminController } from './admin.controller.js'
import { AuthController } from './auth.controller.js'
import { AuthService } from './auth.service.js'
import { ConfigService } from './config.service.js'
import { DatabaseService } from './database.service.js'
import { StorageService } from './storage.service.js'

@Module({
  controllers: [AuthController, AdminController, ApiController],
  providers: [ConfigService, DatabaseService, AuthService, StorageService],
})
export class AppModule {}
