# Crate Digging

**Find the record. Go to the shop. Enjoy the dig.**

Crate Digging helps you find which Berlin record shop has the vinyl you're after, reserve it, and pick it up in store. No shipping, no online checkout — the record is the reason to go, the shop is the whole experience.

> Status: early beta. Pickup only, Berlin only, for now.

---

## Screenshots

<!-- Reorder / rename these captions to match what each image actually shows. -->

![Browse the shops selling on Crate Digging](https://github.com/user-attachments/assets/6a397ca9-440f-4489-94d5-dcd818b28aee)

![Search across every shop, or the full catalogue](https://github.com/user-attachments/assets/a6fa57b4-78c3-4c8c-8ff0-f64893400328)

![A record and where to find it in Berlin](https://github.com/user-attachments/assets/28a1b705-768b-41ac-ae3b-7dfa972f6c28)

![Inside a shop's stock](https://github.com/user-attachments/assets/98300e7a-004f-4f42-8306-db1a8adde7cd)

![Owner view — managing pickups](https://github.com/user-attachments/assets/7b2cd3f0-9b79-4a20-98b0-f2612033f180)

![Messaging between a digger and a shop](https://github.com/user-attachments/assets/e50f97db-25d1-443e-b95c-0a717cb1acbd)

![Your hunting list](https://github.com/user-attachments/assets/e933e3bf-fd88-46f1-9371-209516d6e1f6)

![Signing in](https://github.com/user-attachments/assets/38c9a174-c1cb-422b-8db5-666faf1be44a)

---

## What it does

**For diggers**
- Browse the record shops selling on the app and see what each has in stock.
- Search any artist or title across every shop, or search the full Discogs catalogue.
- Keep a hunting list — even for records no shop stocks yet. It lights up the moment one turns up.
- Reserve a copy so it's held behind the counter, and message the shop directly.

**For shops**
- List your stock for free (search Discogs to add fast, add by hand, or bulk import via [CSV](https://github.com/user-attachments/files/29608206/crate-digging-template.csv) — columns: `artist, title, price`).
- Take reservations: accept, hold, and mark records picked up.
- See what the city is hunting for (most-wanted) and notify interested buyers in one tap.
- Message buyers and manage everything from one place.

**Design touches**
- Dark theme throughout, with a turntable mark and genre-reactive browse tiles.
- Each shop picks a vinyl colour that shows on its records.
- Responsive: a single-column mobile layout, and a wider desktop layout with a left sidebar and multi-column grids.

---

## Tech stack

- **Frontend:** React (single-file component) built with **Vite**.
- **Backend:** [Supabase](https://supabase.com) — Postgres, Row Level Security, and email/password auth.
- **Record data:** the [Discogs API](https://www.discogs.com/developers), called through a Supabase **Edge Function** so the API token never touches the client.
- **Hosting:** [Cloudflare Pages](https://pages.cloudflare.com), auto-deploying from the `main` branch.

---

## Project structure

```
src/
  App.jsx            # the entire app (screens, state, Supabase calls)
  supabaseClient.js  # Supabase client (project URL + publishable key)
  index.css          # global reset — must NOT cap #root width
index.html           # Vite entry
public/
  _redirects         # SPA fallback so refreshes don't 404
```

Supabase pieces (kept in the repo as `.sql` files and an Edge Function):

```
supabase/
  *.sql              # schema + migrations (run in the Supabase SQL editor)
  discogs-search/    # Edge Function that proxies the Discogs search API
```

---

## Getting started (local development)

Requires Node.js 18+.

```bash
npm install
npm run dev
```

The app expects a Supabase project. The project URL and **publishable** (anon) key live in `src/supabaseClient.js` — both are safe to ship in the client. The Discogs token is **not** here; it's stored as a Supabase Edge Function secret.

---

## Backend setup (Supabase)

1. Create a Supabase project.
2. In the **SQL editor**, run the migration files in `supabase/` (in order). Each is safe to re-run.
3. Deploy the **`discogs-search`** Edge Function and add your Discogs personal access token as a secret named `DISCOGS_TOKEN`. Leave "Verify JWT" off so guests can search.
4. Drop your project URL and publishable key into `src/supabaseClient.js`.

Auth, stock, and reservations are protected by Row Level Security: shops, releases, and listings are publicly readable (so guests can browse); reservations, messages, and profiles are scoped to the signed-in user.

---

## Deployment (Cloudflare Pages)

The site auto-builds on every push to `main`.

- **Framework preset:** Vite
- **Build command:** `npm run build`
- **Output directory:** `dist`
- No environment variables needed (Supabase URL/key are in `supabaseClient.js`).

`public/_redirects` contains a single rule so client-side routes don't 404 on refresh:

```
/*    /index.html   200
```

After a push, Cloudflare builds in a minute or two. Hard-refresh (or use a private window) to skip the browser cache.

---

## Roadmap

- Forgot-password and email verification (needs a transactional email provider).
- Back-in-stock alerts by email, not just in-app.
- Light, privacy-friendly analytics for the beta.
- A custom domain and the legal basics (Impressum, privacy policy) before a real public launch.

---

## Notes

This is a solo project built to practise product and product-engineering work end to end — from idea and design to a live, working app. Feedback is welcome.
