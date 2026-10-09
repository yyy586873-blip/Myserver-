const express = require('express');
const path = require('path');
const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname))); // Serve index.html

// In-memory storage
let latestStats = {}; 
let messageHistory = []; 

// 1. Serve Index
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. Receive Stats from Android App
app.post('/api/stats', (req, res) => {
    const { id, text, timestamp } = req.body;
    
    // Update latest stats immediately for real-time view
    if(id === 'monitor_bot') {
        latestStats = {
            id: id,
            text: text,
            timestamp: timestamp || Date.now()
        };
    }
    
    // Keep history for the "Recent Logs" section
    messageHistory.push({ sender: id, text, timestamp: timestamp || Date.now() });
    if(messageHistory.length > 50) messageHistory.shift();
    
    res.json({ success: true });
});

// 3. Get Latest Stats (for polling)
app.get('/api/stats', (req, res) => {
    res.json(latestStats);
});

// 4. Get History (optional, for logs)
app.get('/api/history', (req, res) => {
    res.json(messageHistory);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));