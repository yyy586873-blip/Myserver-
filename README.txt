WORLD CHAT V2
Files:
- server.js
- index.html
- admin.html

GitHub:
Put all 3 files in the same branch/folder.

Render:
Start Command: node server.js

Recommended Environment Variables:
ADMIN_TOKEN = a strong random secret
MESSAGE_ENABLED = true
ATTACHMENT_ENABLED = true
MESSAGE_COOLDOWN_MS = 0
SYNC_BUFFER_LIMIT = 100
FILE_TTL_MS = 1800000
MAX_UPLOAD = 104857600

Important:
Local chat is still stored on each user's device for 24 hours.
For a NEW user to receive recent messages, the server keeps only a small
temporary in-RAM sync buffer. It is not a database and is cleared on restart/redeploy.
The server cannot "scan" another user's local storage; browsers/apps cannot access
other users' private local storage.

Attachments are not auto-downloaded. They appear with a Download button.
Admin token must never be hardcoded into index.html.
