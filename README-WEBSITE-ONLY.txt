CHESS ARENA — WEBSITE-ONLY BUILD

This package is the Chrome/browser website version only.

Removed:
- AndroidApp project and all Android Java/XML/Manifest files.
- Native app MainActivity source.
- Android intent/deep-link launch buttons and app-specific origin allowance.
- "Open in Chess Arena App" buttons from lobby, create, join, player and admin pages.

Preserved:
- Root lobby -> Create/Join -> index.html player flow.
- /Admin.html -> admin lobby flow and existing Admin/Stockfish features.
- Multi-room server and Console.
- Stable reconnect session-token logic, 45-second seat grace period and stale-socket protection.
- Existing Classic UI unchanged.
- Modern, Modern Glass Split and Monochrome theme identities, with lighter rendering (no backdrop blur, simpler surfaces/shadows).
- Smooth move animation default; Spin and Capture FX remain optional Console settings.

Admin waiting status:
- Admin.html now uses the same non-blocking inline waiting banner as index.html.
- The board and player cards remain visible while waiting for the opponent or reconnecting.

Deploy:
1. Extract this ZIP.
2. Upload all root-level files to the GitHub repository root.
3. Commit and push; Render will redeploy.
4. Console remains /console.html and requires the existing CONSOLE_KEY.

Note:
Room/player state is held in server memory. A Render restart clears active rooms, as in the base build.


THEME UPDATE
- Only two Console UI choices are supported: Classic Original and Yellow & Black Arena.
- Classic's original CSS/layout is retained.
- Yellow & Black uses a near-black interface with light-yellow and black board cells.
- Yellow & Black is desktop-optimized with a side panel + large board layout and stacks on mobile.
- Admin inline waiting banner now sits directly below the header, matching the normal player page.
- Reconnect/session token logic and grace-period handling are retained.
