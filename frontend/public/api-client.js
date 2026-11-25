import { messages } from './messages.js';
// Owns the browser session and uses it for requests to the TicketMaestro API.
export class ApiClient {
  #token;
  #origin;
  #onSessionExpired;
  #storage;

  // Save the API origin and session-expiry callback, then restore the token from this tab?s storage.
  constructor(origin, onSessionExpired, storage = sessionStorage) {
    this.#origin = origin;
    this.#onSessionExpired = onSessionExpired;
    this.#storage = storage;
    this.#token = storage.getItem('ticketmaestro-token');
  }

  // Expose the current token so views can tell whether a pending response belongs to the active
  // session.
  get token() {
    return this.#token;
  }

  // Keep the in-memory token and session storage in sync. A cleared token is removed from storage.
  set token(value) {
    this.#token = value;
    if (value) this.#storage.setItem('ticketmaestro-token', value);
    else this.#storage.removeItem('ticketmaestro-token');
  }

  // A late 401 from an earlier session must not sign out the current user.
  // Send JSON requests with the active bearer token and return the parsed response. Attach the HTTP
  // status to errors for callers that handle specific failures.
  async request(path, body, method = body === undefined ? 'GET' : 'POST') {
    const headers = {};
    const requestToken = this.token;
    if (requestToken) headers.Authorization = 'Bearer ' + requestToken;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(this.#origin + '/api' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.status === 401 && requestToken && requestToken === this.token) {
      this.token = null;
      this.#onSessionExpired();
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) {
      throw Object.assign(new Error(result?.error || messages.requestFailed), { status: response.status });
    }
    return result;
  }
}
