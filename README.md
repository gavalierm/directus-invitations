# Directus Invitation Hook Extension

Hook extension for Directus 11+ that manages band invitation workflows — inviting users, accepting invitations, cancellation, expiry cleanup, and email notifications.

## Data Model

Uses the unified `access` table instead of separate junction tables. Each `access` record has three visibility fields (`member`, `manager`, `owner`) with values `public`/`unlisted`/`private`/`null`.

Invitation `role_type` maps to a single access field:

| role_type | Access field set |
|-----------|-----------------|
| `member` | `member = 'public'` |
| `manager` | `manager = 'unlisted'` |
| `owner` | `owner = 'unlisted'` |

Only the corresponding field is set — other fields are left unchanged.

## Features

- **Invite new users** — creates Directus user with `invited` status, generates JWT invite token, sends email
- **Invite existing invited users** — sends new invite email with unique token per invitation
- **Invite active users** — sends accept email with token (no auto-accept)
- **Accept invitation** — JWT-verified PATCH, creates/updates `access` record
- **Immutable invitations** — only accept (status → accepted with valid token) is allowed after creation
- **Cancel invitation** — sends notifications for pending invitations only, silent for accepted
- **Expiry cleanup** — daily cron deletes all invitations older than 7 days
- **Deduplication** — prevents duplicate invitations per email+band+role
- **Email notifications** — Slovak email templates with 7-day TTL info

## Hooks

| Event | Type | Action |
|-------|------|--------|
| `invitations.items.create` | action | Sends invite/accept email, creates user if needed |
| `invitations.items.update` | filter | Validates JWT token, blocks any PATCH except accept |
| `invitations.items.update` | action | Creates/updates access record, sends confirmation emails |
| `invitations.items.delete` | filter | Captures invitation data before deletion |
| `invitations.items.delete` | action | Sends cancellation emails (pending only) |
| Schedule `0 2 * * *` | cron | Deletes invitations > 7 days, cleans up orphan users |

## Invite Flow

```
1. Owner creates invitation in Directus
   → Extension: generates JWT { email, invitation_id, scope: invite }
   → Sends invite email to user (all cases — new, invited, active)
   → Notifies band owners

2. User clicks link → /accept-invite?token=xxx
   → SPA: decodes JWT, fetches invitation detail
   → If user is "invited": shows registration form (name, password)
     → POST /users/invite/accept { token, password }
     → PATCH /items/invitations/{id} { status: "accepted", token }
   → If user is "active" + logged in: shows "Accept" button
     → PATCH /items/invitations/{id} { status: "accepted", token }
   → If user is "active" + not logged in: shows "Log in" view

3. Extension filter hook validates JWT on PATCH
   → Extension action hook upserts access record
   → Sends confirmation to user + notification to owners
```

## Requirements

- Directus 11+
- `invitations` collection: `id`, `email`, `band` (FK → bands), `role_type` (member/manager/owner), `status` (pending/accepted), `user_created`, `date_created`
- `access` collection: `user` (FK → directus_users), `band` (FK → bands), `member`, `manager`, `owner` visibility fields
- Frontend `/accept-invite` page

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INVITATION_APP_URL` | No | `PUBLIC_URL` | Frontend URL for invite links |
| `INVITATION_DEFAULT_ROLE` | No | `AUTH_DEFAULT_ROLE` | Directus role ID for new invited users |
| `SECRET` | Yes | — | JWT signing key (Directus default) |
| `USER_INVITE_TOKEN_TTL` | No | `7d` | Invite token expiration |

## Development

```bash
npm install
npx directus-extension build
npx directus-extension build --watch  # watch mode
```

## License

MIT
