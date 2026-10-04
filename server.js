const express = require('express');
const app = express();
const path = require('path'); // Built-in Node.js module to handle file paths

app.use(express.json());

// Command storage
let commandBuffer = null;

// 1. Serve static files from the 'public' folder (if you have one)
// This allows /style.css or /script.js to load if they are inside a 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// 2. Serve index.html at the root URL (/)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint: Jab tum dashboard se command bhejo
app.post('/send', (req, res) => {
    commandBuffer = req.body.cmd;
    console.log("Command sent:", commandBuffer);
    res.json({ msg: "Command queued" });
});

// Endpoint: Jab client check kare
app.get('/check', (req, res) => {
    if (commandBuffer) {
        const cmd = commandBuffer;
        commandBuffer = null; // Clear after sending
        res.json({ cmd: cmd });
    } else {
        res.json({ cmd: null });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is ready on port ${PORT}`));