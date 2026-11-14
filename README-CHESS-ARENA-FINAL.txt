CHESS ARENA — CHROME WEBSITE + NATIVE ANDROID MULTIPLAYER

CONTENTS
- Website files are at the ZIP root. These are the existing Chrome/browser player lobby, create/join, index, Admin and Console pages.
- Android Studio/AIDE project is in ./src. Its source structure/package is retained: src/app/src/main/java/in/play/chess/.
- LobbyActivity.java is the new Android launcher. MainActivity.java is the online two-player board screen.

CHROME WEBSITE
- Classic Original is the only UI theme. Removed Modern Glass, Monochrome, Yellow/Black and other theme choices.
- Existing browser lobby, player board, Admin page, Console, Stockfish browser files, reconnect/session logic and animations are retained.
- Smooth movement remains the default; Spin and Capture FX remain optional.
- No Android WebView/app-launch UI is used by the website.

ANDROID APP
- App starts in LobbyActivity with Create Game / Join Game and an optional Admin mode switch.
- Room codes are 3 digits and use the same server API as the Chrome website.
- MainActivity keeps the original native chess board drawing and interaction style, but game state/moves are server-authoritative.
- Socket.IO reconnect is enabled. A persistent per-room token is stored in SharedPreferences to resume the same seat during the server's reconnect grace period.
- Legal destination dots are requested from the server, not guessed by the local board rules. The server validates every move.
- Admin mode adds an Admin badge and a fast server-side tactical Suggest Move button. This quick suggestion is a lightweight heuristic, not the Stockfish engine.

ANDROID DEPENDENCY
The app uses the Java Socket.IO client 2.1.1 with Gradle `compile` syntax for compatibility with this older project structure:
  io.socket:socket.io-client:2.1.1
Maven Central is enabled in the project repositories.

DEPLOY SERVER / WEBSITE TO RENDER
1. Upload the root-level website/server files to the existing GitHub repository root.
2. Keep package.json and the existing Render start command (`npm start`).
3. Push to GitHub and wait for Render to redeploy.
4. Confirm https://myserver-b0ls.onrender.com/health returns JSON with ok:true.
5. The app connects to https://myserver-b0ls.onrender.com and uses /api/create-room, /api/join-room and Socket.IO.

BUILD AND INSTALL APP
1. Open the ./src folder as the Android project in Android Studio or AIDE.
2. Allow Gradle to resolve io.socket:socket.io-client:2.1.1 from Maven Central.
3. Build/install the app. Internet permission is already declared.
4. Use the same room code from Chrome and Android to play cross-platform.

IMPORTANT LIMITATIONS
- Room state is held in server memory; a Render restart clears active games.
- Both sides must connect for the game to start. If a player disconnects, the server keeps their seat during its configured reconnect grace period.
- Native Admin Suggest Move is a fast heuristic and is not the browser Stockfish analysis engine.
- Source syntax and website JavaScript were checked, but an Android SDK/Gradle build and live two-device multiplayer test could not be run in this environment. Please build and test on the target AIDE/Android Studio setup before release.
