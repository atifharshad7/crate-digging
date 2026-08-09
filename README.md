# DormTag

**Scan it. Book it. Done.**

DormTag is repair reporting for student halls. Something breaks in your room, you scan the QR sticker on the door, tap what it is, and pick a time the caretaker comes. No email, no waiting for a reply that never arrives.

Every repair is logged to the exact room and fixture, so after a year the operator doesn't see eleven complaints, they see the one pipe causing them.

**Status:** working demo, seeded with a year of example data. German and English. Built as a product engineering exercise.


## What it does

### For residents

* Scan the sticker in the room, tap the fixture, tap what's wrong. Twenty seconds, no typing, no account needed for shared spaces.
* Pick the appointment yourself from times the caretaker actually offered, so nobody rings the bell during a lecture.
* See exactly where it stands, including when a part is on order and what the supplier said.
* Reports are grouped by what needs your attention: pick a time, booked, waiting on a part, reported, done.
* Grant "enter without me" so simple jobs don't need you there at all.

### For caretakers

* One queue instead of a mailbox, split into booked, no appointment, waiting for parts, and with an external firm.
* Offer appointment times on a day strip and hour grid. Hours you're already committed to are greyed out before you submit.
* Close a job with a cause code in four taps and no typing. "Nobody home" is a first-class button, not buried in a menu.
* Hand work you can't legally do to a trade: electrical, plumbing, heating, locksmith, glazing, pest, lift.
* Print QR sticker sheets per building, scoped to the buildings assigned to you.
* Scan a fixture in the corridor to pull up its history on the spot.

### For operators

* Four metrics you can click into: what's open, what's waiting on parts, what's with an external firm, and how often nobody was home.
* Reported-versus-fixed by month. Tap a bar for that month's counts, median fix time, and splits by building, fixture and cause.
* Repeat-fault ranking by riser, which is what turns eleven separate complaints into one plumbing problem.
* Filter everything by period (1, 3, 6 or 12 months) and by building.
* Commission external firms and record the order reference.

## Design notes

* **Sticker granularity follows ambiguity.** One sticker per room, so a four-person flat needs 7 instead of 26. An extra sticker per fixture only where a room holds several of the same type, like a laundry with three washing machines, because "machine 3" has to reach machine 3.
* **Nothing invents a time.** When an appointment falls through the ticket reuses the caretaker's remaining offers and withdraws the rejected one. If none are left it waits for him to propose new ones.
* **Access follows the unit, not the room.** A shared kitchen inside a locked flat still needs somebody to let the caretaker in. Only genuine common areas need nobody present.
* **Analytics are per object, never per person.** The dashboard groups by building, riser and fixture, never by caretaker response time. A system that scores individual employees triggers works-council co-determination in a German public body.
* **Closed tickets are never deleted**, but reporter identities are anonymised a year after closure. The maintenance history is the asset; the link to the person is not.
* German institutional signage as the visual direction: slate enamel plates with mono room codes, traffic yellow reserved for the two things it means (the sticker, and waiting).
* Mobile first. The resident is on a phone, the caretaker is on a phone in a stairwell, and only the operator dashboard wants the width.

## Tech stack

* **Frontend:** React and TypeScript, built with Vite. No framework, no component library.
* **Backend:** a single [Cloudflare Worker](https://workers.cloudflare.com/) with a hand-rolled router, serving both the API and the static assets.
* **Database:** [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite).
* **Auth:** own sessions. Staff use email and password (PBKDF2-SHA256, per-user salt, 100k iterations); residents use an access code. Tokens are stored hashed.
* **QR:** [`qrcode`](https://github.com/soldair/node-qrcode) to generate the sticker sheets, native `BarcodeDetector` with [`jsQR`](https://github.com/cozmo/jsQR) as a fallback for in-app scanning.
* **Housekeeping:** a Cron Trigger runs retention daily.
* **Tests:** 199 end-to-end assertions in a plain Node script, no test framework.
* **Hosting:** Cloudflare Workers, auto-deploying from `main`.

## Project structure

```
worker/
  index.ts           # API, auth, row scoping, state machine, seed, retention
src/
  App.tsx            # app shell, resident and caretaker views
  Operator.tsx       # dashboard: metrics, charts, drill-downs
  Auth.tsx           # sign in, about page, scan landing, sticker sheet
  SlotPicker.tsx     # appointment time picker
  Scanner.tsx        # in-app QR scanner
  lib.ts             # i18n catalogue, label resolution, API client
  styles.css         # design tokens and layout
  main.tsx           # Vite entry
migrations/
  000*.sql           # schema, applied in order
  000*.console.sql   # same statements without comments, for the D1 dashboard
scripts/
  smoke.mjs          # end-to-end tests against a running worker
reference/
  schema.sql         # the Postgres design this started from
  schema-access.sql  # sessions and row-level security policies
  access.ts          # principal resolution for a Node/Postgres runtime
index.html
wrangler.jsonc
```

The `reference/` folder is the Postgres version of the schema, kept because D1 forced two compromises worth documenting: no `EXCLUDE USING gist` for overlapping appointments, and no row-level security, so scoping lives only in `ticketScope()` in the worker.

## Getting started (local development)

Requires Node.js 20+.

```
npm install
npm run build
npm run db:local
npm run dev
```

Then open the printed localhost URL, click **Load demo data** once, and sign in.

Run the tests in a second terminal while `npm run dev` is running:

```
npm run smoke
```

If `wrangler dev` fails with `Address already in use`, a stale `workerd` is holding the port: `pkill -f workerd` and retry.

## Backend setup (Cloudflare D1)

```
npx wrangler login
npx wrangler d1 create dormtag
```

Paste the printed `database_id` into `wrangler.jsonc`, then apply the schema and deploy:

```
npm run db:remote
npm run deploy
```

If you'd rather not use the terminal, create the database in the Cloudflare dashboard and paste each `migrations/000*.console.sql` file into the D1 console in order. Those versions have the comments stripped, because a clipboard that drops line breaks turns a leading `--` into a comment that swallows the whole script.

Finally, open the site and click **Load demo data** once. That writes three buildings, the sticker slugs, the demo accounts, and a year of history with a deliberately planted drain problem on one riser so the repeat-fault view has something to show.

**Demo credentials**, also displayed on the login screen:

| Role | Sign in with |
| --- | --- |
| Resident | code `B312-Z2-DEMO` |
| Caretaker | `hausmeister@wohnheim.test` / `hausmeister-demo-2026` |
| Operator | `verwaltung@wohnheim.test` / `verwaltung-demo-2026` |

Set `DEMO_MODE` to `"false"` in `wrangler.jsonc` before putting the URL anywhere public. It disables the seed endpoint, which wipes the database, and stops the login screen displaying credentials.

## Deployment (Cloudflare Workers)

The site auto-builds on every push to `main` once you've connected the repo under Workers and Pages:

* Build command: `npm run build`
* Deploy command: `npx wrangler deploy`
* No environment variables needed. The D1 binding and the cron schedule live in `wrangler.jsonc`.

`wrangler.jsonc` also sets `not_found_handling: "single-page-application"` so client-side routes like `/r/b312-ku` don't 404 on refresh, and a daily cron at 03:00 for retention.



## Screenshots
<img width="590" height="1278" alt="IMG_7749" src="https://github.com/user-attachments/assets/d472aaa2-38c3-40f6-895e-3d7c2dbacff9" />
<img width="590" height="1278" alt="IMG_7746" src="https://github.com/user-attachments/assets/81b378b0-f0c4-44d0-866b-d883d60d422e" />
<img width="590" height="1278" alt="IMG_7752" src="https://github.com/user-attachments/assets/ac9175a5-1f6f-4d6e-a542-f869844b9195" />
<img width="1179" height="2379" alt="IMG_7748" src="https://github.com/user-attachments/assets/7fdb860a-5126-44f9-bd62-c566ffdd311d" />

<img width="590" height="1278" alt="IMG_7750" src="https://github.com/user-attachments/assets/3eec3556-3ec3-4f15-910c-fc2fde34a1ab" />

<img width="1512" height="864" alt="Screenshot 2026-08-09 at 11 26 00 PM" src="https://github.com/user-attachments/assets/615d00e3-6a49-4b90-8913-23c28875cd8d" />
<img width="1512" height="864" alt="Screenshot 2026-08-09 at 11 26 15 PM" src="https://github.com/user-attachments/assets/605543a8-10b8-49c1-9a4a-3b9533abfeeb" />
<img width="1512" height="864" alt="Screenshot 2026-08-09 at 11 28 22 PM" src="https://github.com/user-attachments/assets/23f49d47-1fe6-4af1-ac80-30c0f00c3165" />
<img width="1512" height="982" alt="Screenshot 2026-08-09 at 7 49 23 PM" src="https://github.com/user-attachments/assets/d954a269-efdd-49ce-a659-37fe953bd9a0" />
<img width="1512" height="982" alt="Screenshot 2026-08-09 at 9 15 47 PM" src="https://github.com/user-attachments/assets/8d2fcd75-1905-402f-8204-f037a89e2e97" />
<img width="1512" height="982" alt="Screenshot 2026-08-09 at 5 52 36 PM" src="https://github.com/user-attachments/assets/58042f24-e02f-4c7e-ae95-fa2c8fabf020" />

