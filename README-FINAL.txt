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
- The app does not contain Create Game or Join Game controls. It only opens a match through a valid deep link launched from index.html or Admin.html.
- Directly launching the app shows “Game page not working” and explains how to open a match.
- Native board, legal-move highlights, board flip, check/checkmate status, reconnect polling, and waiting status are included.
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

LATEST APP LAUNCH FLOW UPDATE
- The native Android app no longer provides Create Game or Join Game controls.
- Launching the app directly shows “Game page not working” with instructions to open a match from index.html or Admin.html.
- A valid chessarena://open deep link must contain room, token, and player/admin mode. The app uses that browser-provided session to enter the existing match.
- The Open in Chess Arena App control is present only on index.html and Admin.html; it is removed from lobby/create/join pages.
- Admin.html control order is Flip Board, New Game, Stockfish AI Coach, Clear Suggestion, Open in Chess Arena App. The app link uses the same .btn styling and grid sizing as the other controls.
- The native app uses the same normal native chess-game screen whether launched from index.html or Admin.html. The web Admin page retains its full Stockfish AI Coach and clear-suggestion features.
