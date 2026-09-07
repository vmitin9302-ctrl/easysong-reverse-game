export function fetchWithDeadline(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response>;
export function fetchWithDeadline<T>(input: RequestInfo | URL, init: RequestInit, timeoutMs: number, consume: (response: Response) => Promise<T>): Promise<T>;
export async function fetchWithDeadline<T>(input: RequestInfo | URL, init: RequestInit, timeoutMs: number, consume?: (response: Response) => Promise<T>): Promise<Response | T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return consume ? await consume(response) : response;
  }
  finally { window.clearTimeout(timeout); }
}
