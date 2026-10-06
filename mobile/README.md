# Studyisfunny Android app (Flutter)

One app with three logins:

- **Student** (phone + student code) and **Parent** (parent phone + student code).
  - Native screens: profile and QR code, balance and points, rank, warnings, every lesson (attendance, homework, exam, comments), and transactions.
  - Videos, homework, booklets and the full student page open the existing website (`shadyelsharkawy.com`) inside the app, already logged in.
  - Uses the existing `/api/portal/*` API; no server changes.
- **Staff** opens the full staff system inside the app. Login is remembered, and QR scanning with the phone camera works.

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

`flutter test` runs the student flow (wrong login, right login, all tabs) against real API responses saved in `test/fixtures`. `flutter test --update-goldens` also saves a screenshot of every screen to `test/goldens/`.

Test build pointing at a local server: `flutter build apk --debug --dart-define=API_BASE=http://10.0.2.2:3401`.
