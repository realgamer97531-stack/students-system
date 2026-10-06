# Studyisfunny Android app (Flutter)

One app with three logins. Every student and parent screen is built into the app; none of them opens the website.

## Student and parent

- Login: phone + student code (student), or parent phone + student code (parent). It is remembered until the user taps **Logout**. When the server's 30-day token expires, the app signs in again by itself with the saved phone and code (stored encrypted), so the user never sees the login screen again.
- Screens: home (profile, photo, balance, points, rank, warnings, QR code, recharge by code, follow-up assistant, comprehensive exams), sessions, videos, homework, booklets, transactions. Parents get home, sessions and transactions.
- Videos: weeks, then lesson cards, with the same rules as the website (status, time left, payment confirmation, popup-question results). The lesson player has explanation / questions / homework-solution parts, resumes from the last position, records watch time, and shows the popup questions (MCQ or essay photo, plus the solution video that must be watched before closing).
  - Uploaded video files play in the phone's own player. YouTube, Vimeo, Bunny and Drive videos can only be played by their own official player, so the app embeds just that player box inside its screen (never the website page).
- The bottom bar stays visible on every page, so the user can switch sections from anywhere, including from inside a video.
- Ads and the "🎬 videos" broadcasts appear on the same pages as on the website.

### Offline

- Every screen shows the last saved data immediately, then refreshes from the server. With no internet, a yellow bar says the data is from the last update. The QR code is saved too, so students can show it at the door with no internet.
- Homework picked with no internet is saved on the phone and uploaded automatically when the internet returns. Watch time is queued the same way.
- Things that need the server right away stay online-only: recharge codes, opening/paying for a lesson, playing videos, popup answers, photo change.

## Staff

- Login with the normal username and password. The first login on a phone needs an admin's username and password once, to register the phone (the same as registering a laptop). Registered phones appear in **/admin/sync-devices**, where they can be revoked.
- Native tabs (shown by permission): **Attendance**, **Homework** and **Door** scanning with the phone camera or by typing the code, plus **System**, which shows the full staff website and signs in by itself.
- Scanning works offline. The app keeps a small snapshot (last 150 sessions, all students, their attendance and homework in those sessions) and checks codes against it. Scans made offline are queued and sent automatically when the internet returns, as the staff member who made them, in the session that was selected then, and with the real scan time. Each scan has a fixed id, so it can never be recorded twice.
- If the server rejects a queued scan (for example, the balance was not enough), it appears under the cloud icon at the top as a problem to fix by hand, and also on **/admin/sync-devices**.
- Server side: `utils/sync/server.js` adds `POST /api/sync/mobile/staff-login` and `GET /api/sync/mobile/snapshot` next to the desktop sync routes. Both only work with a registered device token. **Deploy the server before releasing an app version that has staff scanning.**

## Build and publish an update

On this PC (the Android SDK, Gradle and pub caches are set up on `D:\dev`):

```bash
cd mobile
node tool/release.js     # bumps the version, builds a signed APK, publishes to GitHub Releases
```

- Releases go to the public repo https://github.com/realgamer97531-stack/studyisfunny-mobile-releases. It only holds APK files.
- Phones see the update automatically when the app opens, or via المزيد → تحديثات البرنامج.
- To share the app directly, send the APK (WhatsApp, link, USB). The phone must allow "Install unknown apps" for the app you open it from.

## The signing key — do NOT lose it

Every update must be signed with the same key, otherwise Android refuses to install it over the old app.

- Keystore: `D:\dev\keys\studyisfunny-release.jks`
- Passwords: `D:\dev\keys\key.properties.backup` (the same file is at `mobile/android/key.properties`).

Neither is in git. **Back up the whole `D:\dev\keys` folder** somewhere safe, such as Google Drive or a USB stick.

## Tests

`flutter test` runs the main flows against real API responses saved in `test/fixtures`: student login, every student screen, staying logged in, offline display, automatic re-login after the token expires, and staff phone registration with an offline attendance scan that syncs later. `flutter test --update-goldens` also saves a screenshot of every screen to `test/goldens/`.

Test build pointing at a local server: `flutter build apk --debug --dart-define=API_BASE=http://10.0.2.2:3401`.
