# Flex Friday, as a Cloudflare Worker

Cloudflare now points new projects at Workers rather than Pages, so this version is
a single Worker that serves the site and the two API routes together.

    public/index.html    the whole app
    worker.js            routes /api/kv and /api/finals, everything else is a file
    src/kv.js            reads and writes the shared board in D1
    src/finals.js        box score lookups (optional, needs an API key)
    wrangler.jsonc       config, one line needs your database id
    schema.sql           one table, run once

## 1. Database

Cloudflare dashboard, Storage & Databases, D1. Create a database named `flex-friday`
if you do not already have one. Open it, go to the Console tab, paste in `schema.sql`
and run it. You should see a table called `kv`.

While you are on that page, copy the **Database ID**.

## 2. Paste the id into wrangler.jsonc

Open `wrangler.jsonc` and replace `PASTE_YOUR_DATABASE_ID_HERE` with the id you just
copied. Keep the quotes around it. This is the step that connects the Worker to the
database, and nothing saves without it.

## 3. Put these files in your repo

Replace everything in the repo with the contents of this folder. If a `functions`
folder is still there from the Pages version, delete it. The layout in the repo
should be:

    public/index.html
    src/kv.js
    src/finals.js
    worker.js
    wrangler.jsonc
    schema.sql
    README.md

## 4. Deploy

In Cloudflare, create the app from your Git repo. On the setup screen:

- Build command: leave empty
- Deploy command: `npx wrangler deploy`

Deploy. When it finishes, open `https://your-worker.workers.dev/api/kv?key=ff:health`.
You want to see `{"value":null,"version":0}`. If you see the app instead, the Worker
is not routing; if you see an error naming the DB binding, the database id in
wrangler.jsonc is wrong or missing.

## 5. Optional extras

Both are set in the Worker's Settings, under Variables and Secrets, then redeploy.

- `ANTHROPIC_API_KEY` turns on the box score lookup button. Cents per week.
- `POOL_KEY` requires a password before anyone can post picks.

Secrets set in the dashboard survive a `wrangler deploy`, so you only add them once.

## Notes

Codes are a courtesy lock between friends, not real security.

Writes carry a version number. If two people save in the same second, the second
write is rejected, re-read and re-applied, which is what keeps the one-player-per-week
rule honest instead of letting the later save quietly erase the earlier one.
