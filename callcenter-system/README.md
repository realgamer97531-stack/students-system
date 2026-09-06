# Call Center Console

A small, self-hosted calling system: upload an Excel sheet of contacts, callers
work through it row by row with call/WhatsApp shortcuts and a fixed set of
outcomes, and admins manage accounts, sessions, and exports.

## How it works

- **Backend**: Node.js + Express + MySQL (designed to work with a remote
  database like Hostinger's). Auth is JWT + bcrypt. Row assignment is done
  inside a MySQL transaction using row-level locking (`SELECT ... FOR
  UPDATE`), which is what makes it impossible for two callers to ever get
  the same row, or for a row to be skipped/duplicated — see the comment
  above `claimNextRow` in `backend/src/routes/rows.js`.
- **Frontend**: React (Vite), plain fetch calls to the API, no heavy UI
  framework.

## Project layout

```
backend/    Express API, connects to a MySQL database
frontend/   React app (admin dashboard + caller call screen)
```

## Database setup (Hostinger MySQL)

1. In hPanel, go to **Databases → MySQL Databases** and create a database
   + user if you haven't already. Note the host, port (usually 3306),
   database name, username, and password.
2. Go to **Databases → Remote MySQL** and add the IP address of whatever
   server will run this backend (your laptop's public IP for testing, or
   your production server's IP). Hostinger blocks remote connections from
   any IP not explicitly allowed here — this step is easy to miss and is
   the most common reason a connection fails.
3. Fill in `backend/.env` with those values (see `DB_HOST`, `DB_PORT`,
   `DB_USER`, `DB_PASSWORD`, `DB_NAME` in `.env.example`).
4. Tables are created automatically the first time the backend starts (or
   when you run `npm run seed`). If you'd rather create them yourself in
   phpMyAdmin first, paste `backend/schema.sql` into the SQL tab there —
   it's the exact same schema, just standalone.

**Important if you were previously running this on the local SQLite
version:** switching to MySQL starts with a brand new, empty database —
existing sessions/callers/history in the old SQLite file are not carried
over automatically. If you need that data preserved, let me know and I
can write a one-time export/import script for it before you make the
switch permanent.

## Easiest way to start (recommended)

After unzipping the project, you can skip the manual terminal steps below
entirely:

- **Mac**: double-click `start.command` (first time only: right-click →
  Open, to get past macOS's "unidentified developer" warning)
- **Windows**: double-click `start.bat`
- **Linux**: run `./start.sh`

This automatically installs everything the first time, starts both the
backend and frontend, opens your browser to the admin dashboard, and
**prints a QR code right in the terminal** that callers can scan with
their phone camera to join instantly — no typing an IP address. It also
saves that QR code as `join-qr.png` in the project folder, so you can
share it however's easiest (screen-share it, print it, AirDrop it).

Press `Ctrl+C` in that terminal window to stop both servers.

You still need [Node.js](https://nodejs.org) installed once beforehand —
that part isn't avoidable without turning this into a packaged desktop
app, which is a bigger step I can help with later if you want a true
double-click `.exe`/`.app` with no visible terminal at all.

## Upgrading an existing install

If you already had this running and are just dropping in updated code:
replace your `backend/` and `frontend/` folders (and the root launcher
files) with the new versions. The backend automatically creates any new
tables/columns in your MySQL database the next time it starts — no manual
migration step needed for future updates (this particular update, moving
from SQLite to MySQL, is the one exception — see the database setup
section above).

## Manual setup (if you prefer, or the launcher above doesn't work)

### 1. Backend

```bash
cd backend
cp .env.example .env      # fill in JWT_SECRET and your Hostinger DB_* values
npm install
npm run seed               # creates the tables (if needed) and the first admin account
npm start                  # runs on http://localhost:4000
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev                 # dev server on http://localhost:5173, proxies /api to :4000
```

For production, build a static bundle and serve it with any static file
server (nginx, Caddy, etc.), pointed at your backend's real URL:

```bash
npm run build                # outputs to frontend/dist
```

You'll need to either serve the built frontend from the same domain as the
API (simplest), or update the frontend to call the backend's full URL and
enable CORS for that origin (already enabled broadly in `index.js` — tighten
`cors()` to your real domain before going live).

## Excel format

The uploaded file's **first row must contain headers**. Only **Name** is
required — every other column is optional:

| Student ID | Name | Phone | Parent Phone | Grade | Subject |
|------------|------|-------|---------------|-------|---------|

If you leave out Student ID, Phone, Parent Phone, Grade, or Subject
entirely, the upload still works fine — those fields just show up blank
in the system. A file with only `Name, Phone, Parent Phone` columns is
perfectly valid.

Extra columns beyond these are ignored. Rows with no value in "Name" are
skipped. For WhatsApp links to work correctly, phone numbers should
include the country code (e.g. `+20...`).

### Customizing the column header text

If your spreadsheets use different wording (e.g. "Student Code" instead
of "Student ID", or "Mobile" instead of "Phone"), you don't need to touch
any code — set it in `backend/.env`:

```
COLUMN_HEADER_STUDENT_ID=Student Code
COLUMN_HEADER_NAME=Full Name
COLUMN_HEADER_PHONE=Mobile
COLUMN_HEADER_PARENT_PHONE=Guardian Number
COLUMN_HEADER_GRADE=Grade Level
COLUMN_HEADER_SUBJECT=Course
```

Whatever you set there is matched case-insensitively, in addition to the
built-in common defaults (Name, Phone, Parent Phone, Grade, Subject,
Student ID / ID / Student Code) — so existing files that already use the
default wording keep working even after you customize this. Restart the
backend after editing `.env` for the change to take effect.

## Student ID

Every row now carries an optional Student ID field, shown throughout the
system: on the caller's call screen (next to grade/subject), in the
admin data table, in the caller drill-down view, and in the exported
Excel file. It's also searchable from the Data tab's search box, right
alongside name and phone number.

## Optional student-system integration

The backend exposes an additional server-to-server endpoint:

```text
POST /api/sessions/internal
X-Callcenter-Service-Token: <shared-secret>
```

Set `CALLCENTER_SERVICE_TOKEN` in the call-center backend to enable it. The
student system must use the same value and point `CALLCENTER_INTERNAL_URL` at
this endpoint. The existing JWT login, start page, manual Excel upload,
append, caller workflow, and exports are unchanged.

The endpoint accepts a session name and normalized student rows, creates a
new call session, and returns its ID and imported count. It is optional and
can be disabled from the student system without changing the call-center
database.

## Accounts

- The **admin** account is created via `npm run seed` in the backend.
- Admins create **caller** accounts (and additional admins) from the
  Callers tab in the dashboard.
- Deactivating an account blocks login immediately; it does not delete
  their history.

## Sessions

- **Create a session**: upload an Excel file with a name — this becomes a
  new, independent batch of rows.
- **Add data to an existing session**: upload another file into a session
  you already have running; new rows are appended after the existing ones.
- **Active / inactive**: only active sessions show up for callers to join.
  Deactivating a session pauses it without deleting anything — you can
  reactivate it later and progress picks up where it left off.
- **Restart with a filter**: pick "No answer", "Follow up", or both, and a
  brand-new session is created containing only the matching rows, reset to
  pending. The original session and its full history are untouched.
- **Export**: download the session as an `.xlsx` file with every row's
  current status, disposition, who handled it, and timestamps. You can
  export everything or just the completed rows.
- **Stuck rows**: if a caller closes their tab mid-call, that row stays
  assigned to them (not lost, not reassignable) until they come back or an
  admin releases it via `PATCH /api/admin/rows/:id/release`. (Wiring a
  button for this into the dashboard UI is a natural next step — see ideas
  below.)

## Data table and caller performance

Click any session's name (or "View data") to open its detail page:

- **Data tab**: an in-app, excel-like view of every row in that session —
  filterable by status, outcome, and caller, and searchable by name or
  phone. This is the same data the export produces, but browsable live
  without downloading anything.
- **Caller performance tab**: for each caller, how many rows they've been
  assigned, how many they've finished, and a breakdown by outcome (no
  answer / busy / wrong number / follow up / deals closed). Click
  "View calls" on any caller to see the exact list of students they were
  assigned — this is your "who called who" answer.

The Callers tab in the main dashboard also now shows each account's
all-time assigned/done/deals-closed counts across every session, so you
can compare workload and performance at a glance without opening each
session individually.

## Caller workflow

1. Log in, pick an active session.
2. The next available row loads automatically.
3. Copy or tap to call/WhatsApp the student or parent.
4. Pick an outcome (No answer / Busy / Wrong number / Follow up / Deal is
   done) — this finalizes the row and immediately loads the next one.

If a caller refreshes the page mid-call, requesting "next" again returns
their same in-progress row rather than skipping or duplicating it.

## Ideas worth adding next

- **A visible "release my stuck row" / admin stuck-rows panel** in the UI
  (the API for it already exists — `GET /api/admin/sessions/:id/stuck` and
  `PATCH /api/admin/rows/:id/release`).
- **Live dashboard** (polling or WebSockets) so admins see progress update
  in real time instead of refreshing.
- **Per-caller stats**: calls handled, outcomes breakdown, to spot workload
  imbalances.
- **Call notes field** in addition to the fixed dispositions, for
  free-text context on a lead.
- **Auto-retry queue**: automatically schedule "No answer" rows to resurface
  after N hours, without a manual restart.
- **Audit log** of who changed session status, restarted sessions, etc.
- **Rate-limiting login** to slow down password-guessing attempts.
- **HTTPS + a reverse proxy** (nginx/Caddy) in front of both services in
  production, and a firewall restricting direct access to port 4000.
