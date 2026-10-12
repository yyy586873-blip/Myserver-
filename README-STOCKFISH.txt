CHESS ARENA + STOCKFISH AI COACH

Files in this update:
- server.js: multiplayer server + Stockfish Lite Single engine integration
- index.html: original normal game UI
- Admin.html: same chess UI, Stockfish AI Coach button, suggested move highlight and principal variation
- package.json: dependencies/start command for Render
- STOCKFISH_LICENSE_NOTICE.txt: Stockfish license/source notice

DEPLOY:
1. Copy all files to the root of your existing GitHub repository.
2. Replace server.js, index.html, and Admin.html; add package.json if the repository does not already have one.
   If you already have a package.json, merge the dependencies and start script rather than deleting unrelated project settings.
3. Commit and push to GitHub, then wait for Render to deploy.
4. Normal page: /
   Admin page: /Admin.html

The server installs the Stockfish npm package and selects the lite-single engine. First startup may take a little longer while the engine initializes. Analysis runs for about 1.4 seconds after startup and returns the best move Stockfish found, its principal variation, depth, evaluation and mate score when detected.

Stockfish is strong, but no engine can guarantee a win in every position. The board highlights the recommended move; it does not play the move automatically.

Note: the current Admin flag is not password-based authentication. Do not treat the Admin URL/flag as a secure access control.
