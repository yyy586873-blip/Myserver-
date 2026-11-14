CHESS ARENA — CLASSIC WEBSITE + JAVA 7 ANDROID APP

WEBSITE
- Existing Chrome website files remain in the project: lobby.html, create.html, join.html, index.html, Admin.html, console.html.
- Only the original Classic chess UI is available. Retired themes (including Yellow/Black) have been removed from the UI and Console selector.
- Existing Stockfish Admin browser feature, room management, undo/redo, and reconnect logic are retained.
- Smooth move animation remains ON by default; Spin and Capture FX remain optional Console settings.

ANDROID APP
- MainActivity.java is a single Java 7 Activity with a fully native Android UI (no HTML/WebView).
- Android 8 / API 26 minimum.
- No AndroidX, AppCompat, Fragment, Compose, lambda, Socket.IO dependency, or third-party library.
- Multiplayer uses HTTPS REST API calls to the same Render server. HTTPS is used for secure transport; the app does not use Socket.IO.
- The app uses the same server room state and player seat system as Chrome, so an app player can play against a Chrome player.
- Room code create/join, native board, legal-move highlights, board flip, check/checkmate status, reconnect polling, and waiting status are included.
- HTTP app heartbeat timeout uses the same 45-second seat reconnect grace period after the 15-second heartbeat expiry threshold.

SERVER API ADDED
POST /api/app/join        { code, token }
GET  /api/app/state       ?code=123&token=...
POST /api/app/legal-moves { code, token, square }
POST /api/app/move        { code, token, from, to, promotion }
POST /api/app/new-game    { code, token }
POST /api/app/leave       { code, token }

DEPLOY
1. Replace the website/server files in the GitHub repository root with the files from this package.
2. Keep package.json and package-lock.json (if your repository already has one) and let Render redeploy.
3. Import the AndroidApp folder into Android Studio, or use MainActivity.java with the included AndroidManifest.xml.
4. Build the Android app. The BASE server URL is set to https://myserver-b0ls.onrender.com in MainActivity.java.

IMPORTANT
- App API traffic is HTTP REST over HTTPS, not plain-text HTTP.
- The multiplayer room state is held in server memory; a Render process restart clears active rooms.
- The server JavaScript and embedded HTML JavaScript syntax were checked. A live Render multiplayer/device test and Android SDK build were not run in this environment.
