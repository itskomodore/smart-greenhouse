/** Error body shape shared by every HTTP error (docs/API.md "Errors"). */
export interface ErrorBody {
  error: string;
  message: string;
  [extra: string]: unknown;
}

export function errorBody(code: string, message: string, extra: Record<string, unknown> = {}): ErrorBody {
  return { error: code, message, ...extra };
}
