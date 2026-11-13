CHESS ARENA + STABLE STOCKFISH AI COACH

WHAT CHANGED
- Stockfish now runs inside a browser Web Worker on Admin.html, not inside the Node.js multiplayer server.
- This keeps chess analysis from blocking the server event loop and reduces the chance of a reconnect during analysis.
- The engine is reused after first load. Analysis targets about 1.1 seconds, with a timeout and visible error feedback.
- The Admin board highlights the recommended from/to squares and shows the engine score, depth, and principal variation.
- The suggested move is not played automatically.

FILES
- server.js: multiplayer server and route for Stockfish engine assets from node_modules/stockfish/bin
- index.html: original player UI (unchanged)
- Admin.html: AI Coach runs in a browser Worker
- package.json: pinned Stockfish dependency and start script
- STOCKFISH_LICENSE_NOTICE.txt: license/source notice

DEPLOY
1. Copy these files to the root of your existing GitHub repository.
2. Replace server.js and Admin.html; keep index.html unchanged. Add package.json only if the repo does not already have one.
   If package.json already exists, merge the stockfish dependency and preserve existing settings/scripts.
3. Commit and push to GitHub, then wait for Render to finish deploying. Render must run npm install (or npm ci if a lockfile is used) so node_modules/stockfish contains the engine files.
4. Open /Admin.html and start a two-player game. The first analysis may take longer because the browser loads/initializes the engine.

URLS
- Player: /
- Admin: /Admin.html

TROUBLESHOOTING
- If the engine reports a loading error, after deploying the latest server.js, confirm these assets return HTTP 200 (not 404):
  /stockfish/stockfish-19-lite-single.js
  /stockfish/stockfish-19-lite-single.wasm
- If you already have a package-lock.json, regenerate/commit it after adding the pinned dependency.
- The Admin flag is not password-based authentication; do not treat the Admin URL/flag as secure access control.

TEST NOTE
JavaScript syntax was checked locally. A live Render/browser runtime test was not possible in this environment, so verify the two engine asset URLs after deploying.


CONSOLE SETTINGS
----------------
Open /console.html to view live room status and move history. To unlock controls, add a CONSOLE_KEY environment variable in Render and enter the same value in the console. Use a private, hard-to-guess value. The console can switch among five complete UI layouts: Classic (original/default), Modern Glass, Arena Side Rail, Compact, and Minimal Paper. It can also choose Glide, Bounce, Fade, Spin, or Arc piece movement effects. Piece animation remains OFF by default. Undo/redo controls and Stockfish AI Coach remain included. Settings reset to Classic + animation OFF + Glide after a server restart.


DYNAMIC UI / ANIMATION UPDATE
- Console UI choices: Classic (original/default), Modern Glass, Minimal Paper, and Monochrome Split (high-contrast black/white with a different layout).
- Movement animation defaults OFF. The selected preset defaults to Smooth Glide; Spin is the alternative.
- When movement animation is enabled, captures have piece-specific effects: Pawn pop, Rook impact, Bishop shimmer, Knight jump, King pulse, and Queen fade/bubble arrival.
- These settings are broadcast to both index.html and Admin.html. The console controls still require the Render CONSOLE_KEY environment variable.
- UI settings are stored in server memory and reset after a server restart.


UI POLISH UPDATE (2026-10-14)
- Classic remains the original/default layout.
- Modern Glass, Minimal Paper, and Monochrome Split have been polished.
- Monochrome uses high-contrast black/white piece glyphs and legal-move dots.
- Minimal Paper moves Flip Board into the header area; Monochrome places it beside its turn indicator under the board.
- Default movement preset is ON: smooth glide with spin layered into the path, plus a fading captured-piece effect and distinct arrival animations by capturing piece type.
- The animation preset is fixed; Console keeps a master on/off switch.


UI style options (final polish): Classic Original (default), Modern Glass, and Monochrome Split. Minimal Paper has been removed. Monochrome Split keeps the side-rail layout and uses a black/dark interface with a white-and-red chessboard, while retaining Classic piece rendering and Classic legal-move dots. The permanent Spin + Smooth Glide + Capture FX animation bundle remains enabled by default and can be toggled off in Console.


MONOCHROME SPLIT UPDATE (2026-10-14)
- Information panels and controls use a black/dark theme.
- Chessboard squares use white and red; Classic piece appearance and legal-move dots are retained.
- Existing split layout, board tools, and animation behavior remain unchanged.


UI / animation update (October 2026)
- Added Modern Glass Split: the Monochrome Split responsive layout with Modern Glass panels and the Modern Glass blue/gray chessboard. It does not use the red-and-white board.
- Existing Classic Original, Modern Glass, and Monochrome Split options remain available.
- Default movement is a lightweight smooth glide. Spin and Capture FX are optional, independently controlled in Console and default OFF.
- Server settings reset on restart to Classic Original + smooth movement ON + Spin OFF + Capture FX OFF.

MULTIPLAYER ROOM LOBBY
----------------------
The site root (/) opens lobby.html. Players choose Create Game or Join Game.
Create Game reserves an available 3-digit room code; Join Game validates that
code before entering the board. The chess board URL is /index.html?room=123.
Each room has its own independent chess position and two player seats. A room
with no connected players is removed after 10 minutes, allowing that code to
be created again. Room state is held in server memory and resets if the Render
service restarts. Admin.html and console.html can be opened with ?room=123 to
work with a specific room. Waiting status is displayed inline above the board,
not as a blocking popup.

ADMIN LOBBY AND MULTI-ROOM CONSOLE UPDATE

- Opening / shows the normal Create / Join lobby for index.html.
- Opening /Admin.html without a room opens the Admin Create / Join lobby.
- The Admin lobby creates or joins a room and then opens /Admin.html?room=123.
- Admin joins as a real player seat (White if free, otherwise Black if free). It can play normally and use the existing Admin-only tools.
- If the Admin tab/player disconnects, that seat is released. The remaining player sees the room return to Waiting for the missing player. Reopening the same Admin room URL can take the free seat again.
- Console now unlocks once and can list/select any active room. Room monitor, move history, undo and redo apply to the selected room. UI settings remain global and apply to all rooms.
- Open /console.html, unlock with CONSOLE_KEY, refresh the room list, then choose a room and press Open room.
- Room state is held in memory; restarting the Render service clears all rooms. Empty rooms expire after 10 minutes.


STABILITY / RECONNECT FIX (NOVEMBER 2026)
-----------------------------------------
- Each browser/app room gets a persistent random player session token in localStorage.
- Reconnecting with the same token reclaims the same White/Black seat instead of taking the other seat.
- If the same session is opened in another tab/device, the newest connection takes over that seat; the old socket is disconnected and cannot release the new socket's seat.
- A dropped connection shows the other player as disconnected and pauses the game. The seat is held for 45 seconds for automatic reconnect, then released if the session does not return.
- Socket.IO heartbeat and reconnect timing are tuned for transient network/Render wake-up interruptions.
- The join-room API checks only that a room exists. Seat assignment is done once, atomically, by the Socket.IO joinGame event, avoiding the old API-check / socket-claim race.
- Console automatically re-authenticates after a temporary reconnect if its key remains in the page, and reopens its previously selected room.
- Console undo/redo refreshes the room list move counts.
- Added /health endpoint for a basic server health check.

ANDROID APP PROJECT
-------------------
- AndroidApp/ contains a Java 7 Android project and local HTML UI assets.
- MainActivity.java uses only Android SDK classes, no lambdas, no AndroidX, and no AppCompat.
- Minimum SDK is API 26 (Android 8).
- App launch opens the normal local lobby. Website's Open in Chess Arena App intent link transfers player/admin mode, room code and the player session token where available.
- The Android UI is loaded from bundled assets under appassets.androidplatform.net; it does not load the hosted website as its UI.
- The app uses the same Render server as the authoritative game engine and Socket.IO server. Internet is required for creating/joining a room and playing.
- The Socket.IO client script is loaded from the Render server at runtime, so the lobby/HTML UI is bundled offline but live multiplayer is not offline.
- Admin Stockfish Worker behavior inside Android WebView needs device testing; the Chrome Admin page remains the fallback if WebView blocks the cross-origin engine Worker.

SECURITY NOTES
--------------
- HTTPS only for app-to-server communication. WebView file/content access is disabled, Safe Browsing is enabled where supported, and no JavaScript bridge is exposed.
- Player session tokens are for reconnect continuity, not user identity or account authentication.
- Admin.html is still a public admin-mode page, not password-protected. Protect any sensitive admin operations with a server-side admin login before exposing them.
- Console controls remain protected by the CONSOLE_KEY environment variable.

TESTING
-------
- Node server syntax checked successfully.
- Inline JavaScript in the web pages and bundled app HTML checked successfully.
- ZIP integrity checked before delivery.
- A live Render two-device test and Android APK build/device test were not available here. Test a disconnect/reconnect on two devices after deploying.

ANDROID NATIVE APP NOTE (v3.0)
The AndroidApp module now uses a native Java/XML interface and a Java Socket.IO client. It no longer loads the local HTML UI. The hosted browser pages remain unchanged except that the Open in Chess Arena App link has been moved into the board action row beside Flip Board. The native app currently supports room create/join, player seat joining/reconnect, live board state, legal move requests, moves, board flip and game-over New Game. The browser Admin page retains the full Stockfish AI Coach; that specific coach UI/action is not yet ported to the native Android screen.
