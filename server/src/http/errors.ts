// Domain errors and their HTTP mapping (api.md §1.4/§1.5). Handlers throw
// AppError; the router turns it into the error envelope. Anything else is a 500
// whose message never leaks to the client.

export type ErrorDetails = Record<string, unknown>;

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetails | undefined;

  constructor(status: number, code: string, message: string, details?: ErrorDetails) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: ErrorDetails) =>
  new AppError(400, code, message, details);
export const unauthorized = (code = "unauthorized", message = "authentication required") =>
  new AppError(401, code, message);
export const forbidden = (code = "forbidden", message = "not allowed") => new AppError(403, code, message);
export const notFound = (code = "not_found", message = "not found") => new AppError(404, code, message);
export const conflict = (code: string, message: string, details?: ErrorDetails) =>
  new AppError(409, code, message, details);
export const invalid = (fields: Record<string, string>) =>
  new AppError(422, "invalid", "validation failed", { fields });

export interface ErrorBody {
  error: { code: string; message: string; details?: ErrorDetails };
}

export function errorBody(err: AppError): ErrorBody {
  const body: ErrorBody = { error: { code: err.code, message: err.message } };
  if (err.details !== undefined) body.error.details = err.details;
  return body;
}
