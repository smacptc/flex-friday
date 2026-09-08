# Flex Friday on Cloudflare Pages

Free, never sleeps, and the six of you share one board. Budget about half an hour
the first time. Everything below is done in a browser, no command line.

## What is in this folder

    index.html               the app
    functions/api/kv.js      reads and writes the shared board
    functions/api/finals.js  looks up box score numbers (optional)
    schema.sql               one table, run once

Keep the folder structure exactly as it is. Cloudflare turns the `functions`
folder into your API routes based on the file paths, so moving those files
changes the URLs and the app stops finding them.

## 1. Make the database

1. Sign up at cloudflare.com, free plan.
2. In the dashboard sidebar, open **Storage & Databases**, then **D1**.
3. **Create Database**. Name it `flex-friday`. Create.
4. Open it, go to the **Console** tab, paste the contents of `schema.sql`, run it.

You should see the `kv` table appear.

## 2. Put the site up

1. Sidebar, **Compute (Workers & Pages)**, then **Create**, then the **Pages** tab.
2. Choose **Upload assets**. Name the project `flex-friday`.
3. Drag this whole folder in, `functions` included. Deploy.

You now have a URL like `https://flex-friday.pages.dev`. It will not save
anything yet, and the app will say so at the top of the screen. That is expected
until step 3.

If the upload does not pick up the functions, use **Connect to Git** instead:
push this folder to a GitHub repo, point Pages at it, leave the build command
empty and the output directory as `/`.

## 3. Connect the database to the site

1. Your Pages project, **Settings**, then **Bindings**, then **Add**.
2. Choose **D1 database**.
3. Variable name must be exactly `DB`. Pick `flex-friday`. Save.
4. **Deployments**, then retry or redeploy the latest one.

That redeploy matters. Bindings only reach code that was deployed after the
binding existed, so skipping it is the usual reason people see "Nothing is being
saved" with everything else set up correctly.

Reload the site. The warning banner should be gone. Create the pool, send the
link to the other five, each claims a name and sets a code.

## 4. Optional, box score lookups

The "Find final numbers" button needs an Anthropic API key, which lives on the
server and never touches the browser.

1. Get a key at console.anthropic.com and add credit to the account.
2. Pages project, **Settings**, **Variables and Secrets**, **Add**.
3. Type **Secret**, name `ANTHROPIC_API_KEY`, paste the key. Save, then redeploy.

Each weekly lookup is one request with web search, so it costs cents, not
dollars. Skip this entirely if you would rather type six numbers on Tuesday.
Without the key the button returns a plain message and hand grading still works.

## 5. Optional, a password on writes

Anyone with the link can post picks otherwise. To lock it:

1. **Settings**, **Variables and Secrets**, add a secret named `POOL_KEY` with a
   password of your choosing. Redeploy.
2. Each person opens the site, and in the browser console runs
   `localStorage.setItem("ff:poolkey","your-password")`, once per device.

Clunky, and honestly for six friends the link being unlisted is usually enough.

## Costs

Nothing, at your size. Pages allows 500 builds a month, D1's free tier is far
past what a 6 by 18 week season uses, and nothing pauses for being idle. The
only thing that can cost money is the optional API key.

## Two things worth knowing

The codes are a courtesy lock, not real security. They stop your friends from
posting under each other's names. They are not built to stop someone determined,
and the roster document holds their hashes.

Simultaneous saves are handled properly. Every write carries a version number,
and if two of you save in the same second the second write is rejected, re-read,
and re-applied, which is what keeps the one-player-per-week rule honest instead
of letting the later save quietly erase the earlier one.
