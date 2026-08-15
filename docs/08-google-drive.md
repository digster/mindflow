# 8. Google Drive integration

Optional. MindFlow is fully functional without it.

Reference implementation: [`src/io/drive/`](../src/io/drive/).

## Design goals, in priority order

1. **Request the absolute minimum permission.** MindFlow must never be able to
   see the rest of someone's Drive.
2. **Work from a static page.** No backend, no client secret, no server-side
   token exchange.
3. **Remember one folder.** Boards live in a single folder that persists across
   sessions.
4. **Load nothing until asked.** No third-party script touches the page until the
   user clicks "Connect Drive".

## The permission model

MindFlow requests exactly one scope:

```
https://www.googleapis.com/auth/drive.file
```

Google classifies `drive.file` as **non-sensitive**. It grants per-file access to
files the application itself created, or that the user explicitly handed to it —
and to nothing else. Because it is non-sensitive, it also avoids the verification
review that restricted Drive scopes require.

### What this means in practice

**MindFlow can:**
- Create a folder in your Drive.
- Create, read, update and trash board files it created inside that folder.
- List the contents of the folder it created.

**MindFlow cannot:**
- See any other file or folder in your Drive.
- See files you put into the MindFlow folder yourself.

### The limitation, stated plainly

> **A file you drop into the MindFlow folder by hand through drive.google.com is
> invisible to MindFlow.**

This is not a bug and not something to engineer around — it is precisely what
`drive.file` means. MindFlow did not create that file, so it has no access to it.

Resolving it requires the **Google Picker**, which lets a user explicitly grant
access to an existing file. That is a deliberate later addition: the Picker needs
an additional API key, an App ID, and a script loaded from Google's CDN, and the
auto-folder flow covers the common case without any of them.

**Workaround today:** open the file locally with `Cmd+O`, then save it to Drive.

## Authentication

### Why the token flow

MindFlow has no backend, so the authorisation-code flow is unavailable — it
requires a client secret, and a secret shipped in a static page is not a secret.

The correct pattern is Google Identity Services' **token flow**
(`google.accounts.oauth2.initTokenClient`), which returns a short-lived access
token directly to the page. There is no refresh token and nothing durable to leak.

```
user clicks "Connect Drive"
  → load https://accounts.google.com/gsi/client   (first time only)
  → initTokenClient({ client_id, scope: drive.file })
  → requestAccessToken()
  → Google consent screen
  → access token, ~1 hour, held in memory only
```

The token is **never** written to localStorage, sessionStorage or a cookie. When
it expires, MindFlow silently requests a new one; if the user's Google session is
still live and the scope already granted, that succeeds without any prompt.

Concurrent requests hitting an expired token are coalesced, so several Drive calls
at once produce one consent prompt rather than five.

### Drive cannot work from `file://`

> A page opened by double-clicking reports its origin as `null`, and Google will
> not accept `null` as an authorised JavaScript origin.

This is a hard constraint of OAuth, not a MindFlow limitation. Everything else in
MindFlow works perfectly from a local file; only Drive requires `http://` or
`https://`.

MindFlow detects this and says so rather than failing obscurely.

For local development, `npm run serve` provides an `http://localhost:8000` origin.

## Setup

Drive needs an OAuth Client ID, which you create once.

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create
   (or select) a project.
2. Enable the **Google Drive API** for it.
3. Configure the OAuth consent screen. Choose **External** unless you have a
   Workspace organisation. Add `.../auth/drive.file` under scopes — it will be
   listed as non-sensitive.
4. Create credentials → **OAuth client ID** → **Web application**.
5. Add your exact origins under **Authorized JavaScript origins**:
   - `https://<your-username>.github.io` for GitHub Pages
   - `http://localhost:8000` for local development
6. Copy the Client ID.

Then supply it either way:

- **Build time** — put it in `.env` as `MINDFLOW_GOOGLE_CLIENT_ID` and rebuild.
- **Runtime** — paste it into MindFlow's Settings dialog. Stored in localStorage,
  and it overrides the build-time value.

The runtime option means a fork can be pointed at a different Google project
without rebuilding.

### A Client ID is not a secret

It ships in the client bundle by design. The security boundary is the
**Authorized JavaScript origins** list: a Client ID is useless from an origin you
have not authorised.

### Unverified app warning

Until the OAuth consent screen is submitted for verification, Google shows an
"unverified app" interstitial. For personal use, continue past it via *Advanced →
Go to (app name)*. A project in testing mode supports up to 100 users.

Because `drive.file` is non-sensitive, verification is comparatively
straightforward if you do want to publish.

## Folder resolution

The folder ID is cached in `localStorage` under `mindflow.drive.folderId`, so the
app returns to the same place every session. A cached ID can go stale — the folder
may have been deleted, trashed, or access revoked — so it is always verified before
use, and resolution walks a fallback chain:

1. **The stored ID**, if it still resolves and is not trashed.
2. **A folder of the right name that this app previously created.** Under
   `drive.file` this search can only ever see MindFlow's own folders, which is
   exactly the recovery wanted and no more.
3. **Create a new one**, named `MindFlow` by default (`MINDFLOW_DRIVE_FOLDER_NAME`).

Step 2 is what stops a cleared browser profile from scattering duplicate
"MindFlow" folders across someone's Drive.

If you rename the folder in Drive, MindFlow picks up the new name rather than
fighting it.

## API usage

Plain `fetch` against the Drive v3 REST endpoints — not Google's `gapi` client
library, which would be another CDN script the single-file design specifically
avoids.

| Operation | Request |
|---|---|
| Verify folder | `GET /drive/v3/files/{id}?fields=…` |
| Find our folder | `GET /drive/v3/files?q=name='…' and mimeType='application/vnd.google-apps.folder' and trashed=false` |
| Create folder | `POST /drive/v3/files` with `mimeType: application/vnd.google-apps.folder` |
| List boards | `GET /drive/v3/files?q='{folderId}' in parents and trashed=false&orderBy=modifiedTime desc` |
| Create board | `POST /upload/drive/v3/files?uploadType=multipart` |
| Update board | `PATCH /upload/drive/v3/files/{id}?uploadType=media` |
| Read board | `GET /drive/v3/files/{id}?alt=media` |
| Delete board | `PATCH /drive/v3/files/{id}` with `{"trashed": true}` |

A `401` drops the cached token and retries **once** with a freshly-requested one,
so a session crossing the hour boundary never surfaces an error.

Values interpolated into a `q=` query are escaped — Drive's query syntax uses
single-quoted literals, so a folder name containing an apostrophe would otherwise
break the query or alter its meaning.

### Deletion is trashing

`deleteBoard` sets `trashed: true` rather than issuing a hard delete. The user can
restore the board from Drive's own trash, and an app operating under a minimal
permission grant should not be able to destroy data irrecoverably.

### App properties

Every uploaded board carries private metadata, invisible to other applications:

```json
"appProperties": {
  "mindflowSchemaVersion": "1.0.0",
  "mindflowBoardId": "brd_7Kq2mXp4Zt"
}
```

This lets MindFlow identify its own files in a listing regardless of their
filename, and makes the board's schema version queryable without downloading it.

## Listing behaviour

The folder listing filters to plausible board files: anything carrying MindFlow's
`appProperties`, or whose name ends in `.mindflow.json` or `.json`. Sub-folders
are excluded outright.

The folder may contain other things the user put there, and offering to open a PDF
as a board would be unhelpful.

## Disconnecting

*Disconnect* revokes the access token with Google, clears it from memory, and
forgets the stored folder ID. **Nothing in Drive is deleted** — the folder and all
boards remain, and reconnecting finds them again via the fallback chain.

To revoke access entirely, use
[Google Account → Third-party apps](https://myaccount.google.com/permissions).

## What MindFlow never does

- Store an access token anywhere persistent.
- Request any scope beyond `drive.file`.
- Read, list or touch any file outside its own folder.
- Contact Google at all until the user clicks "Connect Drive".
- Send board contents anywhere other than Google Drive.

There is no MindFlow server. There is nothing to send anything to.
