# Refaktor: directus-invitations na access model

## Kontext

Pôvodný model používal 3 junction tabuľky: `members`, `admins`, `owners`. Nový model ich nahrádza jednou `access` tabuľkou s fieldmi `member`, `manager`, `owner` (visibility hodnoty: public/unlisted/private/null).

## Hook architektúra

| Hook | Typ | Účel |
|---|---|---|
| `invitations.items.create` | action | Pošle invite email, vytvorí usera ak neexistuje |
| `invitations.items.update` | filter | Overí JWT, blokuje akýkoľvek PATCH okrem `{ status: "accepted", token }` |
| `invitations.items.update` | action | Po accept zapíše access záznam |
| `invitations.items.delete` | filter | Zachytí dáta pred zmazaním |
| `invitations.items.delete` | action | Cancellation email (len pending) |
| `schedule 0 2 * * *` | cron | Maže invitations > 7 dní, cleanup orphan users |

`handleUserActivated` hook **odpadá**.

## Invitation CREATE flow

```
Owner vytvorí invitation
  ├─ User neexistuje → create directus_user (invited) + invite email
  ├─ User invited → invite email (nový token)
  └─ User active → accept email
Vždy: notifikácia ownerom kapely. Žiadny auto-accept.
```

## Accept flow (SPA + Extension)

```
/accept-invite?token=xxx
  SPA: dekóduje JWT → { email, invitation_id }
  SPA: lazy fetch invitation detail (spinner)
  SPA: skontroluje stav usera
    ├─ invited → formulár (meno, priezvisko, heslo)
    │   → POST /users/invite/accept
    │   → PATCH /items/invitations/{id} { status: "accepted", token }
    │   → auto-login → /profile
    ├─ active + prihlásený → "Akceptovať" tlačidlo
    │   → PATCH /items/invitations/{id} { status: "accepted", token }
    │   → refresh dát → /profile
    └─ active + neprihlásený → "Prihláste sa" view
```

## Access zápis (exkluzívny)

| role_type | Zápis |
|---|---|
| member | `member = 'public'` |
| manager | `manager = 'unlisted'` |
| owner | `owner = 'unlisted'` |

Ostatné polia nedotknuté. Ak access záznam neexistuje → INSERT. Ak existuje → UPDATE len príslušný field.

## Immutability (filter hook)

Invitation je po vytvorení immutable. Jediný povolený PATCH: `{ status: "accepted", token: "jwt" }`. JWT sa overuje (podpis, expirácia, scope, invitation_id). Token sa odstráni z payloadu pred zápisom.

## JWT token

```json
{ "email": "x@y.com", "invitation_id": 68, "scope": "invite" }
```

## Delete hook

- pending → email pozvanému + ownerom
- accepted → tichý

## Cron (2:00 denne)

- Maže všetky invitations > 7 dní (oba stavy)
- Pending expiry → email
- Orphan invited users → delete

## Emaily

- Všetky okrem "accept successful" obsahujú info o 7-dňovej platnosti
- Accept owner notifikácia: `first_name + last_name`, email len fallback
- "Boli ste pridaný" (tvrdé y)
- role_type enum: member/manager/owner
