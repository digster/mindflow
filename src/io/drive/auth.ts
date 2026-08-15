/**
 * Google OAuth for a static, server-less page.
 *
 * ---------------------------------------------------------------------------
 * The flow, and why it is this one
 * ---------------------------------------------------------------------------
 * MindFlow has no backend, so the authorisation-code flow is unavailable: that
 * requires a client secret, and a secret shipped in a static page is not a
 * secret. The correct pattern here is Google Identity Services' *token flow*
 * (`initTokenClient`), which returns a short-lived access token directly to the
 * page. There is no refresh token and nothing durable to leak — when the token
 * expires after roughly an hour, the user is asked again (silently, if their
 * session is still live).
 *
 * ---------------------------------------------------------------------------
 * Scope: `drive.file` and nothing more
 * ---------------------------------------------------------------------------
 * Google classifies `drive.file` as NON-SENSITIVE. It grants access *only* to
 * files this application itself created, or that the user explicitly handed to
 * it. MindFlow can never see the rest of someone's Drive, and because the scope
 * is non-sensitive it avoids the verification review that restricted Drive
 * scopes require.
 *
 * The tradeoff, documented in `docs/08-google-drive.md`: a file dropped into the
 * MindFlow folder by hand through drive.google.com is invisible to the app,
 * because MindFlow did not create it. Resolving that would need the Google
 * Picker, which is a deliberate later addition.
 *
 * ---------------------------------------------------------------------------
 * Drive cannot work from file://
 * ---------------------------------------------------------------------------
 * A double-clicked page reports its origin as `null`, and Google will not accept
 * `null` as an authorised JavaScript origin. This is a hard constraint of OAuth,
 * not something to engineer around, so the app detects it and says so plainly.
 */

declare const __GOOGLE_CLIENT_ID__: string;
declare const __GOOGLE_SCOPE__: string;

const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const CLIENT_ID_STORAGE_KEY = 'mindflow.google.clientId';

/** Refresh this long before actual expiry, so a request never races the deadline. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  callback: (response: TokenResponse) => void;
  requestAccessToken(options?: { prompt?: string }): void;
}

interface GoogleGlobal {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type?: string; message?: string }) => void;
      }): TokenClient;
      revoke(token: string, done?: () => void): void;
    };
  };
}

export class DriveAuthError extends Error {
  override readonly name = 'DriveAuthError';
  constructor(
    message: string,
    /** True when the user can fix this themselves (config, popup blocker, origin). */
    readonly actionable = true,
  ) {
    super(message);
  }
}

/** True when the page is on a real origin Google will accept. */
export function isOriginSupported(): boolean {
  return window.location.protocol === 'http:' || window.location.protocol === 'https:';
}

/**
 * The configured Client ID.
 *
 * A runtime value set in Settings wins over the build-time one, so a fork can be
 * pointed at a different Google project without rebuilding.
 */
export function getClientId(): string {
  const stored = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (stored && stored.trim() !== '') return stored.trim();
  return typeof __GOOGLE_CLIENT_ID__ === 'string' ? __GOOGLE_CLIENT_ID__ : '';
}

export function setClientId(clientId: string): void {
  const trimmed = clientId.trim();
  if (trimmed === '') localStorage.removeItem(CLIENT_ID_STORAGE_KEY);
  else localStorage.setItem(CLIENT_ID_STORAGE_KEY, trimmed);
  // A different project means a different token; drop the current one.
  cachedToken = null;
  tokenClient = null;
}

export function getScope(): string {
  return typeof __GOOGLE_SCOPE__ === 'string'
    ? __GOOGLE_SCOPE__
    : 'https://www.googleapis.com/auth/drive.file';
}

// ---------------------------------------------------------------------------
// Script loading
// ---------------------------------------------------------------------------

let scriptPromise: Promise<GoogleGlobal> | null = null;

/**
 * Loads Google Identity Services on first use.
 *
 * Deliberately lazy. Until the user clicks "Connect Drive", the page loads no
 * third-party code and contacts no third-party server — so MindFlow works
 * offline, works from a local file, and does not hand Google a page view from
 * everyone who merely opens a board.
 */
function loadGoogleIdentityServices(): Promise<GoogleGlobal> {
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<GoogleGlobal>((resolve, reject) => {
    const existing = (window as unknown as { google?: GoogleGlobal }).google;
    if (existing?.accounts?.oauth2) {
      resolve(existing);
      return;
    }

    const script = document.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const google = (window as unknown as { google?: GoogleGlobal }).google;
      if (google?.accounts?.oauth2) resolve(google);
      else reject(new DriveAuthError('Google Identity Services loaded but did not initialise.', false));
    };
    script.onerror = () =>
      reject(
        new DriveAuthError(
          'Could not load Google Identity Services. Check your network connection, or whether a content blocker is blocking accounts.google.com.',
        ),
      );
    document.head.append(script);
  });

  // Let a later attempt retry rather than caching the failure forever.
  scriptPromise.catch(() => {
    scriptPromise = null;
  });

  return scriptPromise;
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let tokenClient: TokenClient | null = null;
let inFlight: Promise<string> | null = null;

export function isConnected(): boolean {
  return cachedToken !== null && cachedToken.expiresAt > Date.now() + TOKEN_EXPIRY_MARGIN_MS;
}

/**
 * Returns a usable access token, prompting the user only when necessary.
 *
 * `interactive: false` requests a silent refresh (`prompt: ''`), which succeeds
 * when the user still has a live Google session and has already granted the
 * scope. That is what makes a mid-session token expiry invisible.
 *
 * A silent request that needs interaction fails rather than popping a window
 * unexpectedly — browsers block popups not triggered by a click anyway.
 */
export async function getAccessToken(interactive = true): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + TOKEN_EXPIRY_MARGIN_MS) {
    return cachedToken.accessToken;
  }

  // Coalesce concurrent callers: several Drive requests hitting an expired token
  // at once must produce one consent prompt, not five.
  if (inFlight) return inFlight;

  inFlight = requestToken(interactive).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function requestToken(interactive: boolean): Promise<string> {
  if (!isOriginSupported()) {
    throw new DriveAuthError(
      'Google Drive needs a real web address and cannot work from a file opened directly from disk. ' +
        'Open MindFlow over http:// or https:// — for local development, run `npm run serve`.',
    );
  }

  const clientId = getClientId();
  if (clientId === '') {
    throw new DriveAuthError(
      'No Google OAuth Client ID is configured. Add one in Settings, or set MINDFLOW_GOOGLE_CLIENT_ID in .env and rebuild.',
    );
  }

  const google = await loadGoogleIdentityServices();

  return new Promise<string>((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: getScope(),
        // Reassigned per request below; GIS requires a callback at construction.
        callback: () => {},
        error_callback: (error) => {
          reject(
            new DriveAuthError(
              error.type === 'popup_closed'
                ? 'The Google sign-in window was closed before finishing.'
                : error.type === 'popup_failed_to_open'
                  ? 'The Google sign-in window was blocked. Allow popups for this site and try again.'
                  : (error.message ?? 'Google sign-in failed.'),
            ),
          );
        },
      });
    }

    tokenClient.callback = (response) => {
      if (response.error || !response.access_token) {
        reject(
          new DriveAuthError(
            response.error_description ??
              (interactive
                ? `Google sign-in failed (${response.error ?? 'unknown error'}).`
                : 'Your Google session has expired. Connect to Drive again.'),
          ),
        );
        return;
      }

      cachedToken = {
        accessToken: response.access_token,
        expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
      };
      resolve(response.access_token);
    };

    // `prompt: ''` asks for a silent grant; `consent` forces the picker.
    tokenClient.requestAccessToken({ prompt: interactive ? '' : '' });
  });
}

/** Clears the in-memory token and asks Google to revoke it. */
export async function disconnect(): Promise<void> {
  const token = cachedToken?.accessToken;
  cachedToken = null;
  tokenClient = null;
  if (!token) return;

  try {
    const google = await loadGoogleIdentityServices();
    await new Promise<void>((resolve) => google.accounts.oauth2.revoke(token, resolve));
  } catch {
    // Already dropped locally, which is the part that matters here.
  }
}

/** Discards the cached token without revoking it, forcing a refresh on next use. */
export function invalidateToken(): void {
  cachedToken = null;
}
