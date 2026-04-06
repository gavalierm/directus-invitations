# Directus Invitation Hook Extension

Hook extension for Directus 11+ that manages band invitation workflows — inviting users, accepting invitations, cancellation, expiry cleanup, and email notifications.

## Features

- **Invite new users** — creates Directus user with `invited` status, generates JWT invite token, sends email with activation link
- **Add existing users** — detects active users and creates junction records (members/admins/owners) immediately
- **Accept invite** — compatible with native `POST /users/invite/accept` endpoint
- **Cancel invitation** — sends notifications, cleans up orphaned invited users
- **Expiry cleanup** — scheduled daily job removes accepted and expired (7-day TTL) invitations
- **Deduplication** — prevents duplicate invitations and duplicate junction records
- **Email notifications** — customizable Slovak email templates via MailService

## Requirements

- Directus 11+
- `invitations` collection with fields: `id`, `email`, `band` (FK), `role_type` (member/admin/owner), `status` (pending/accepted), `user_created`, `date_created`
- Frontend page at `/accept-invite` that handles `POST /users/invite/accept`

## Installation

### Option A: Git source (recommended for updates)

Clone directly into your Directus extensions directory:

```bash
cd /path/to/directus/extensions/
git clone git@github.com:gavalierm/directus-invitations.git directus-hook-invitation-handler
```

Restart Directus to load the extension.

**To update:**

```bash
cd /path/to/directus/extensions/directus-hook-invitation-handler
git pull
```

Restart Directus.

### Option B: Manual copy

1. Copy `dist/index.js` and `package.json` to `extensions/directus-hook-invitation-handler/`
2. Restart Directus

### Option C: Docker

```dockerfile
FROM directus/directus:latest

USER root
RUN corepack enable
USER node

RUN mkdir -p /directus/extensions/directus-hook-invitation-handler
COPY dist/index.js /directus/extensions/directus-hook-invitation-handler/
COPY package.json /directus/extensions/directus-hook-invitation-handler/
```

## Configuration

Set these environment variables in your Directus instance:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INVITATION_APP_URL` | No | `PUBLIC_URL` | Frontend URL for invite links (e.g. `https://yourapp.com`) |
| `INVITATION_DEFAULT_ROLE` | No | `AUTH_DEFAULT_ROLE` | Directus role ID assigned to newly invited users |
| `SECRET` | Yes (Directus default) | — | Used for signing JWT invite tokens |
| `USER_INVITE_TOKEN_TTL` | No | `7d` | Invite token expiration |

### Example `.env`

```env
INVITATION_APP_URL=https://yourapp.com
INVITATION_DEFAULT_ROLE=c86c2761-65d3-43c3-897f-6f74ad6a5bd7
```

If `INVITATION_APP_URL` is not set, the extension falls back to `PUBLIC_URL` (Directus public URL).

If `INVITATION_DEFAULT_ROLE` is not set, the extension falls back to `AUTH_DEFAULT_ROLE`.

## How It Works

### Hooks

| Event | Trigger | Action |
|-------|---------|--------|
| `invitations.items.create` | New invitation created | Checks user status: active → junction + email, invited → notify owners, new → create user + invite email |
| `invitations.items.delete` | Invitation cancelled | Sends cancellation emails (pending only), cleans up orphaned invited users |
| `directus_users.items.update` | User status → active | Processes all pending invitations, creates junction records, sends welcome emails |
| Schedule `0 2 * * *` | Daily at 2:00 AM | Deletes accepted invitations (silent), expired pending (7 days) with notifications, cleans up orphans |

### Invite Flow

```
1. Owner creates invitation record
   → Hook: new user? Creates user (invited) + sends invite email with token
   → Hook: existing user? Creates junction + marks accepted + sends notification

2. New user clicks invite link → /accept-invite?token=xxx
   → Frontend: POST /users/invite/accept { token, password }
   → User becomes active

3. Hook: user activated
   → Creates junction records for all pending invitations
   → Sends welcome email to user + notification to owners
```

## Development

```bash
npm install
npx directus-extension build
```

Watch mode:

```bash
npx directus-extension build --watch
```

## Collection Schema

The `invitations` collection must exist in Directus with:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | integer (PK, auto) | Yes | — |
| `email` | string | Yes | Invited user email |
| `band` | integer (FK → bands) | Yes | Target band |
| `role_type` | string (dropdown) | Yes | `member`, `admin`, or `owner` |
| `status` | string | Yes | `pending` (default) or `accepted` |
| `user_created` | uuid (system) | No | Who created the invitation |
| `date_created` | timestamp (system) | No | When (used for TTL) |

## License

MIT
