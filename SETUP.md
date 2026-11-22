# Setting up Shelf Date Tracker

This puts the app online at its own web address, with a shared database and daily phone alerts. It's all free. Plan on about an hour the first time.

You'll make two free accounts:
- **Supabase**: the database. It stores products, dates and logins.
- **GitHub**: hosts the app's web address and sends the daily alerts.

> **Try it first:** open the app before setup and tap **Try demo mode**. Everything works except sharing and alerts, and data stays on that phone.

---

## Part 1: Database (Supabase)

1. Go to **supabase.com** and sign up.
2. Click **New project**.
   - Name: `shelf-date-tracker`
   - Database password: click **Generate**, then save it in your password manager. You won't need it often.
   - Region: the one closest to your store.
   - Click **Create new project** and wait 1–2 minutes.
3. In the left menu, click **SQL Editor**, then **New query**.
4. Open `supabase/schema.sql` from this folder, copy all of it, paste it in, and click **Run**. You should see "Success. No rows returned."
5. In the left menu, click **Project Settings**, then **API** (it may be called **Data API** or **API Keys**). Keep this page open. You need three things from it:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon / public** key (long text)
   - **service_role** key (long text, marked secret). **This one never goes in the app.**

## Part 2: Connect the app to the database

Open `config.js` in this folder with Notepad and fill in the first two lines:

```js
export const SUPABASE_URL = "https://abcd1234.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOi...the anon key...";
```

Leave the third line (`VAPID_PUBLIC_KEY`) as it is. It's already filled in. Save the file.

## Part 3: Put it online (GitHub)

1. Go to **github.com** and sign up.
2. Click **+** (top right), then **New repository**.
   - Name: `shelf-date-tracker`
   - Choose **Public**. Free hosting needs a public repository. Your store's data isn't in it; that lives in Supabase.
   - Click **Create repository**.
3. On the new page, click **uploading an existing file**.
4. Open this folder in File Explorer, select everything, and drag it into the browser. **Never upload your private key file.** It has been moved out of this folder to `Documents\shelf-date-tracker-PRIVATE-keys.txt`. If you ever make new keys and `keys.local.txt` shows up here, move it out before uploading.
5. Click **Commit changes**.
6. Check that a `.github` folder appears in the file list. If it doesn't (some browsers skip folders starting with a dot):
   - Click **Add file**, then **Create new file**.
   - Name it exactly `.github/workflows/daily-alerts.yml`.
   - Paste in the contents of that file from this folder, then click **Commit changes**.
7. Go to **Settings**, then **Pages**. Under **Branch**, pick `main` and `/ (root)`, then click **Save**.
8. After a minute or two, the page shows your app's address, like `https://YOUR-NAME.github.io/shelf-date-tracker/`. **That's your app.**

## Part 4: Let sign-up emails link back to your app

In Supabase, go to **Authentication**, then **URL Configuration**:
- **Site URL**: your app's address from Part 3, step 8.
- **Redirect URLs**: add that same address.
- Click **Save**.

## Part 5: Turn on daily alerts

In GitHub, open your repository, then go to **Settings**, **Secrets and variables**, **Actions**. Click **New repository secret** for each of these five:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL from Part 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | the **service_role** key from Part 1 |
| `VAPID_PUBLIC_KEY` | the `VAPID_PUBLIC_KEY=` value in `Documents\shelf-date-tracker-PRIVATE-keys.txt` |
| `VAPID_PRIVATE_KEY` | the `VAPID_PRIVATE_KEY=` value in that same file |
| `VAPID_SUBJECT` | `mailto:` plus your email, like `mailto:you@example.com` |

Secrets are hidden. Nobody can read them back, including you, and they're not public even in a public repository.

Then click the **Actions** tab. If GitHub asks, click **I understand my workflows, go ahead and enable them**.

## Part 6: Set up your phone

1. Open your app's address in **Safari** (iPhone) or **Chrome** (Android).
2. Add it to your home screen:
   - **iPhone:** Share button, **Add to Home Screen**, **Add**.
   - **Android:** **⋮** menu, **Add to Home screen** or **Install**.
3. **Open it from the home screen icon.** On iPhone, alerts only work when you open it this way.
4. Tap **Create account**, enter your email and a password, then open the confirmation email and tap the link.
5. Sign in and tap **Start a new store**, e.g. "Store 214 Dairy".
6. Go to the **Store** tab and tap **Turn on alerts**. Allow notifications when asked.
7. On the Store tab, choose what time the daily alert comes. 6 AM is the default.

### Test an alert
1. Log a milk item that expires within 2 days, so there's something to alert about.
2. In GitHub, go to **Actions**, **Daily alerts**, **Run workflow**, check **Send now**, and click **Run workflow**.
3. Your phone should get the alert within a minute.

## Part 7: Add coworkers

On the **Store** tab you'll see a 6-character **store code**. Coworkers:
1. Open the app's address and add it to their home screen.
2. Create their own account.
3. Enter your store code.

Only you, the person who started the store, can change alert timing.

---

## Good to know

- **Updating the app:** upload the changed files to GitHub the same way, and change `VERSION` at the top of `sw.js` (e.g. `sdt-v2`) so phones get the new version.
- **Supabase pauses unused free projects after a week with no activity.** Daily use keeps it awake. If it pauses, click **Restore** in Supabase.
- **GitHub turns off the hourly alert job after 60 days with no changes to the repository.** If alerts stop, go to **Actions**, **Daily alerts**, and click **Enable workflow**.
- **Weak signal in the cooler:** the app opens and shows the last loaded items with no signal, but changes only save with a connection.
- **Never share** the service_role key or `keys.local.txt`. Everything in `config.js` is meant to be public.

## Testing on your computer

With Node installed, run this in this folder:

```powershell
node dev-server.mjs
```

Then open http://localhost:5173.
