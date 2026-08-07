import { HttpException, HttpStatus } from '@nestjs/common'

const codes: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'bad_request',
  [HttpStatus.UNAUTHORIZED]: 'unauthorized',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.TOO_MANY_REQUESTS]: 'rate_limited',
}

export function apiError(status: number, detail: string): HttpException {
  const code = codes[status] ?? (status >= 500 ? 'server_error' : 'request_failed')
  return new HttpException({ code, detail }, status)
}
