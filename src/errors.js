/** An error that carries the HTTP status and machine-readable code to return to the caller. */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }

  static badRequest(message, details) {
    return new ApiError(400, 'bad_request', message, details)
  }

  static unauthorized(message = 'Missing or invalid x-api-key header.') {
    return new ApiError(401, 'unauthorized', message)
  }

  /** Authenticated, but not allowed. Distinct from 401, which means unidentified. */
  static forbidden(message = 'Not permitted.') {
    return new ApiError(403, 'forbidden', message)
  }

  static notFound(message = 'Route not found.') {
    return new ApiError(404, 'not_found', message)
  }

  static conflict(message, details) {
    return new ApiError(409, 'conflict', message, details)
  }

  static unavailable(message, details) {
    return new ApiError(503, 'service_unavailable', message, details)
  }

  static gateway(message, details) {
    return new ApiError(502, 'upstream_error', message, details)
  }
}
