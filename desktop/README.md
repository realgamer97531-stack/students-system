# Studyisfunny Desktop (offline app)

The whole system running on a laptop. It works without internet and syncs with the online server.

## How it works

- Each laptop has its own copy of the database (a bundled MariaDB) and runs the same `server.js`, so every page works offline.
- Every action that changes data is saved in an upload queue on the laptop. The queue survives restarts and power cuts. It uploads immediately when online, or later when the internet comes back.
- The online server replays each action using its own rules. That means:
  - balances and points are added correctly from every laptop;
  - the server assigns all real IDs, so IDs never overlap;
  - each action is applied at most once (`sync_applied_ops`);
  - offline actions keep their original time.
- If the server rejects an offline action (for example, the balance was already used up from another laptop), the action is **not applied**. It shows under "⚠ عمليات مرفوضة" in the toolbar, and in **Settings → أجهزة برنامج الديسكتوب** on the website.
- Downloads happen when the app starts, every 5 minutes, and when you press "⬇ تحديث البيانات" (full re-download). A download only runs after everything on the laptop has been uploaded.
- **Need internet:**
  - adding students (single, quick-add, bulk);
  - photo, image and video uploads;
  - call-center sending;
  - backups and Settings import/clear;
  - deleted-students restore;
  - recharge codes;
  - managing users, videos, ads and popup questions.

  When online, the laptop sends these straight to the server. When offline, it shows a "محتاج إنترنت" message.

## Order of deployment

1. Deploy the server first (`git push students-system main`). This adds the `/api/sync/*` endpoints and 2 new tables (`sync_devices`, `sync_applied_ops`). No existing table is changed.
2. Then build and install the desktop app.

Always deploy server changes **before** releasing a desktop update that depends on them.

## Build the installer (USB)

```bash
cd desktop
npm install
npm run dist
```

The output is `desktop/dist/Studyisfunny-Setup-<version>.exe`. Copy it to a flash drive and double-click it on any Windows laptop. It installs in seconds, with no admin rights needed, and creates a desktop shortcut.

The installer is not code-signed, so Windows may show "Windows protected your PC". Click **More info → Run anyway**.

First launch on a laptop:
1. Enter a name for the laptop plus an **admin** username and password.
2. The app downloads all the data. This needs internet once.

After that, it works offline.

## Publishing an update (the in-app update button)

One-time setup:
1. Create a **public** GitHub repo `realgamer97531-stack/studyisfunny-desktop-releases`. It only holds installer files; the source code stays private.
2. Create a GitHub token that can write releases to that repo (fine-grained: *Contents: Read and write* on that repo).

Each release:

```bash
cd desktop
set GH_TOKEN=<your token>        # PowerShell: $env:GH_TOKEN="<your token>"
npm run release                  # bumps the version, builds, uploads to GitHub Releases
```

Laptops then show "⭳ تنزيل التحديث" in the toolbar (they check automatically every 6 hours, or when the button is pressed). After downloading, "✔ تثبيت التحديث" closes the app, installs the update, and reopens it. Data and the upload queue are kept.

## Where things are on a laptop

- Program: `%LOCALAPPDATA%\Programs\studyisfunny-desktop`
- Data, config and logs: `%APPDATA%\Studyisfunny`. If the Windows username has Arabic letters, the database lives in `C:\StudyisfunnyData` instead.
- The ⚙ button shows the device name, the server, and a shortcut to the logs folder. It can also re-register the laptop.
- Lost or stolen laptop: on the website, open **Settings → أجهزة برنامج الديسكتوب → إلغاء تسجيل**.

## Code map

- `utils/sync/` (online server): device registration, download endpoints, replaying uploaded actions.
- `desktop/runtime/` (inside the app only): upload queue, sync engine, ID mapping, needs-internet handling.
- `desktop/app/` (Electron): window, toolbar, setup screen, problems list, local MariaDB, offline CDN cache, updater.
- `desktop/scripts/prepare.js`: assembles the server, MariaDB and CDN files into `desktop/staging` before a build. It refuses to package `.env` or other secret files.
