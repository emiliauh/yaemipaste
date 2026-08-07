import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { AuthService } from './auth.service.js'
import { ConfigService } from './config.service.js'
import { apiError } from './errors.js'

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly config: ConfigService) {}

  @Post('register') @HttpCode(200) register(@Body() body: { username?: string; password?: string; token?: string }) { return this.auth.register(body.username ?? '', body.password ?? '', body.token ?? '') }

  @Post('login') @HttpCode(200) login(@Req() request: Request, @Body() body: { username?: string; password?: string; turnstile_token?: string }) { if (!this.auth.rateLimit(`login:${request.ip}`, 10, 60_000)) throw apiError(429, 'Too many login attempts'); return this.auth.login(body.username ?? '', body.password ?? '', body.turnstile_token ?? '') }

  @Post('token/status') @HttpCode(200) tokenStatus(@Body() body: { token?: string }) {
    const token = body.token?.trim() ?? ''
    if (!token) throw apiError(400, 'Token is required')
    return { status: this.auth.tokenStatus(token) }
  }

  @Get('me') me(@Req() request: Request) { return this.auth.userData(this.auth.currentUser(request)) }

  @Get('sharex') sharex(@Req() request: Request, @Res() response: Response) {
    if (!this.config.value.sharexEnabled) throw apiError(400, 'ShareX support is disabled')
    const user = this.auth.currentUser(request)
    const uploadApi = (process.env.PASTE_API?.trim() || `${this.config.value.publicUrl}/api`).replace(/\/+$/, '') + '/'
    const body = {
      Version: '15.0.0', Name: `yaemipaste (${user.username})`, DestinationType: 'ImageUploader, FileUploader, TextUploader', RequestMethod: 'POST', RequestURL: uploadApi, Headers: { Authorization: user.token }, Body: 'MultipartFormData', FileFormName: 'file', URL: '{regex:^(.+)$|1}', ThumbnailURL: '', DeletionURL: '', ErrorMessage: '{response}',
    }
    response.setHeader('Content-Disposition', 'attachment; filename="yaemipaste.sxcu"')
    response.setHeader('Content-Type', 'application/json')
    return response.end(JSON.stringify(body))
  }

  @Post('password/change') @HttpCode(200) changePassword(@Req() request: Request, @Body() body: { old_password?: string; new_password?: string }) {
    return this.auth.changePassword(request, body.old_password ?? '', body.new_password ?? '')
  }

  @Post('change-password') @HttpCode(200) changePasswordLegacy(@Req() request: Request, @Body() body: { old_password?: string; new_password?: string }) { return this.changePassword(request, body) }

  @Post('logout-all-devices') @HttpCode(200) logoutAll(@Req() request: Request) { return this.auth.logoutAllDevices(request) }
  @Post('sessions/logout-all') @HttpCode(200) logoutAllLegacy(@Req() request: Request) { return this.logoutAll(request) }

  @Get('passkeys') passkeys(@Req() request: Request) { this.auth.currentUser(request); return this.auth.passkeyList(request) }
  @Post('passkeys/register/begin') @HttpCode(200) passkeyRegisterBegin(@Req() request: Request) { return this.auth.passkeyRegisterBegin(request) }
  @Post('passkeys/register/finish') @HttpCode(200) passkeyRegisterFinish(@Req() request: Request, @Body() body: { credential?: unknown }) { return this.auth.passkeyRegisterFinish(request, body.credential) }
  @Delete('passkeys/:id') passkeyDelete(@Req() request: Request, @Param('id') id: string) { return this.auth.passkeyDelete(request, Number(id)) }
  @Post('passkeys/auth/begin') @HttpCode(200) passkeyAuthBegin(@Body() body: { username?: string }) { return this.auth.passkeyAuthBegin(body.username ?? '') }
  @Post('passkeys/auth/finish') @HttpCode(200) passkeyAuthFinish(@Body() body: { username?: string; credential?: unknown }) { return this.auth.passkeyAuthFinish(body.username ?? '', body.credential) }

  @Post('admin/bootstrap') @HttpCode(200) bootstrap(@Req() request: Request, @Body() body: { username?: string; password?: string; token?: string }) { this.auth.requireAdminBearer(request); return this.auth.bootstrap(body.username ?? '', body.password ?? '', body.token ?? '') }
  @Post('admin/tokens') @HttpCode(200) createToken(@Req() request: Request, @Body() body: { label?: string; ttl_seconds?: number }) { this.auth.requireAdminBearer(request); return { token: this.auth.createRegistrationToken(body.label ?? 'generated', body.ttl_seconds) } }
  @Delete('admin/tokens/:token') revokeToken(@Req() request: Request, @Param('token') token: string) { this.auth.requireAdminBearer(request); return this.auth.revokeToken(token) }
}
