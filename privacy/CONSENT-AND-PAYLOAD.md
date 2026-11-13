# Consent copy + contribution payload

Everything in this folder is the "share anonymous stats" feature, end to end:
`CONSENT-AND-PAYLOAD.md` (copy + contract), `payload.schema.json`, `validate_payload.py`,
`example_payload.json` (passes), `example_payload_leaky.json` (must fail).

Rules the copy follows: separate from install, default off, decline offered as an equal choice
(not a grey link), no pre-checked box, exact payload preview before the first send, one-click
revoke, and a named retention period. The app is fully functional with sharing off — say so.

Placeholders: `{{APP}}`, `{{POLICY_VERSION}}`, `{{PRIVACY_URL}}`, `{{CONTACT_EMAIL}}`.

---

## 1. Consent screen (first run, after the app has opened a folder)

**Title:** Share anonymous stats?

**Body:**

> {{APP}} works completely without this. Nothing here is required.
>
> If you turn it on, {{APP}} sends a small summary of your play — session lengths, kill and death
> counts, class and level, gold ranges, auction price ranges, profession skill, rare spawn gaps —
> to our server. We use it to build public stats, like average gold per hour by zone, and to
> publish price history for items.
>
> **What we never send:** your character names, your account, your guild or its roster, your
> Battle.net details, your IP in the data itself, chat, notes, or anything you typed.
>
> **We coarsen before sending:** dates become days (never times), gold becomes ranges, prices
> become ranges, damage totals are rounded.
>
> We keep the raw summaries for 90 days, then only aggregated numbers remain. Public pages only
> show a figure when at least 20 separate installs are behind it.
>
> [ Preview exactly what would be sent ]   [ Privacy policy ]

**Primary button:** `Share anonymous stats`
**Secondary button:** `No thanks` — same size, same weight, right next to it.

> Do not pre-tick anything, do not hide the decline behind a link, and do not re-ask on every
> launch. Re-ask once, in Settings, after a major feature ships.

## 2. Preview modal

**Title:** This is the exact payload

**Body above the JSON:**

> Below is the real request body, built from your data right now. You can save it to a file
> instead of sending it.

Line summary above the JSON:

> 1 session · 2 characters' wealth · 2 item prices · 1 profession · 1 rare
> Estimated size: ~1.4 KB

Buttons: `Send it` · `Save to file` · `Cancel`

## 3. Settings toggle (after opt-in)

**Label:** Share anonymous stats
**State line under it:**

> On — last sent 12 Nov 2026, 1.4 KB. Next send after your session ends.
> Off — nothing has been sent. {{APP}} works the same either way.

Buttons: `Preview what would be sent` · `Delete everything we have` · `Change my mind`

## 4. Revoke + delete flow

**Confirm dialog:**

> Delete everything we have about this install?
>
> This removes the summaries you've sent and the aggregate rows tied to your install ID. Numbers
> already published on public pages can't be recalled, because they are averages with no install
> attached.
>
> Your local database is untouched. This does not affect your characters or your game.

Buttons: `Delete my uploaded data` (destructive styling) · `Keep sharing` · `Just turn it off`

**Receipt (after deletion):**

> Done. We deleted N records for install `…7c31` on 13 Nov 2026.
> Sharing is now off. You can turn it back on at any time; a new install ID will be created, so
> nothing you send later can be connected to what we just deleted.

## 5. Policy paragraph (for the privacy page)

> **Aggregated gameplay statistics.** If you enable "Share anonymous stats", {{APP}} sends
> day-bucketed summaries of your gameplay to {{CONTACT_EMAIL}}'s server: session durations,
> kill and death counts, class and level, gold and item-value ranges, profession skill levels and
> rare-spawn intervals. We do not receive character names, account information, guild or roster
> data, chat, or free text, and payloads are validated on our side to reject any that contain
> them. Raw summaries are retained for 90 days and then reduced to aggregates. Published figures
> require at least 20 distinct installs. You can preview, disable or delete your contributed data
> at any time in Settings; deletion removes everything tied to your install ID. Consent is
> recorded with the policy version (currently {{POLICY_VERSION}}) and can be withdrawn without
> affecting the rest of the app. Full policy: {{PRIVACY_URL}}.

---

## 6. Field contract

**Never leaves the machine, ever**

| Data | Why |
| --- | --- |
| Character name / surname / slug | Identifies a person; hashing is reversible over a small name space |
| Player GUID / API character id | Stable link across all data |
| Account name, Battle.net tag, email | Account identity |
| Guild name and any roster member data | Third-party data; those players never consented |
| Chat, notes, custom labels | Free text is unbounded personal data |
| Raw log lines, raw SavedVariables | Contain every one of the above |

**Leaves only as a coarsened value**

| Field | Example | Rule |
| --- | --- | --- |
| date | `2026-11-12` | day bucket, never a time |
| duration_bucket | `4-6h` | fixed buckets |
| money_bucket | `10-25g` | fixed buckets, never copper |
| unit_price_bucket | `1-10s` | fixed buckets |
| quantity_bucket | `200-1000` | fixed buckets |
| dps_bucket | `10-20` | fixed buckets |
| spawn_gap_bucket | `4-8h` | fixed buckets |
| damage_done / damage_taken | `232000` | rounded to nearest 1,000 |
| kills / deaths | `495` / `1` | exact counts, no timestamps attached |
| level | `33` | exact at ≤60, use `level_range` above |
| class, zone_id, item_id, npc_id, house_id | `PALADIN`, `1456`, `2589`, `3295`, `110` | public game data |

## 7. Transport contract

```
POST /v1/contribute
Content-Type: application/json
X-Install-Id: <uuid4>            # same value as the body; kept for logging/rate limits
X-Signature: hmac-sha256(body, install_key)   # key issued once at registration
X-Idempotency-Key: sha256(body)               # re-sends are harmless

202 Accepted  { "received": 1, "rejected": 0 }
400 Bad Request { "errors": ["...violations..."] }   # never store on 400
409 Conflict   { "duplicate": true }                 # already seen this payload
DELETE /v1/contribute/{install_id}   -> 200 { "deleted": N }
```

Server duties, in order:

1. Reject any payload that fails `validate_payload.py` — do not sanitise and keep, reject.
2. Rate-limit per install; a client that sends hourly is broken.
3. Outlier rejection before aggregation (clients lie, and mistakes are common).
4. k-suppression at publish time: a figure appears only with ≥20 distinct installs behind it.
5. Publish aggregates only — no per-install rows in any public endpoint.
6. 90-day raw retention, enforced by a job, not by intention.

## 8. Why this shape

- **Separate from install** because consent bundled into an install flow is treated as not freely
  given (ICO: consent "should not be bundled up as a condition of service").
- **Preview before send** because a user who sees the JSON and still approves has given
  demonstrably informed consent, and it costs one modal.
- **Buckets, not hashes** because ranges cannot be reversed and hashes can.
- **Reject, don't sanitise** because a validator that quietly strips fields will one day strip
  the wrong one silently, and you will never know.
