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
