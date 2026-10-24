// A business error we expect and want to show the caller, e.g. 422 INSUFFICIENT_FUNDS.
// The error handler in app.ts turns it into {code, message, request_id}.
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
