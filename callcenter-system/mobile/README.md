# Call center app (Android)

This Flutter app is for Android phones only. It opens the call-center system (`AppConfig.callCenterUrl`) inside a WebView:

- `tel:` links open the phone dialer. WhatsApp links open WhatsApp. Any other site opens in the browser.
- The login lives in the WebView's storage, so callers stay logged in.
- The Excel export doesn't work inside the WebView, because it builds the file in the browser (blob). The app tells the user to export from a computer instead.
- The app checks GitHub releases `realgamer97531-stack/callcenter-mobile-releases` for updates at startup, and again on resume at most every 6 hours.
- It is locked to portrait. The User-Agent ends with `SECallCenterApp/<version>`.

## Build and release

The heavy caches live on D: (C: is nearly full):

```bash
export PUB_CACHE='D:\dev\pub-cache' GRADLE_USER_HOME='D:\dev\gradle'
flutter build apk --release        # build/ is a junction to D:\dev\callcenter-build
node tool/release.js               # bumps version, builds, uploads to GitHub Releases
node tool/release.js --no-bump     # same, without bumping (first release, or a retry)
```

Signing uses the same key as the student app (`android/key.properties` → `D:/dev/keys/studyisfunny-release.jks`). That file isn't in git.
