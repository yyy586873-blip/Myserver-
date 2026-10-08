const express = require('express');
const app = express();
const path = require('path');

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname))); // Serve index.html

// In-memory storage (Restart pe clear ho jayega)
let messages = [];
let polls = {}; // { pollId: { options: [], votes: [] } }
let usersTyping = {};

// 1. Serve Index
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. Get Messages & Status
app.get('/api/messages', (req, res) => {
    // Find who is typing
    let currentTypers = Object.keys(usersTyping).filter(id => usersTyping[id]);
    res.json({ messages, typing: currentTypers[0] || null });
});

// 3. Send Message
app.post('/api/messages', (req, res) => {
    const { action, id, text, timestamp } = req.body;
    
    if (action === 'send') {
        messages.push({ sender: id, text, timestamp });
        // Keep last 50 messages only
        if(messages.length > 50) messages.shift();
    }
    res.json({ success: true });
});

// 4. Typing Status
app.post('/api/status', (req, res) => {
    const { id, typing } = req.body;
    usersTyping[id] = typing;
    res.json({ ok: true });
});

// 5. Create Poll
app.post('/api/polls', (req, res) => {
    const { id, question, options, timestamp } = req.body;
    const pollId = 'p_' + Date.now();
    polls[pollId] = {
        id: pollId,
        question,
        options,
        votes: [],
        totalVotes: 0
    };
    // Add as a special message
    messages.push({
        sender: id,
        type: 'poll',
        text: question,
        pollData: polls[pollId],
        timestamp
    });
    res.json({ pollId });
});

// 6. Vote in Poll
app.post('/api/vote', (req, res) => {
    const { pollId, voterId, option } = req.body;
    if(polls[pollId]) {
        // Remove previous vote if exists
        polls[pollId].votes = polls[pollId].votes.filter(v => v.voter !== voterId);
        // Add new vote
        polls[pollId].votes.push({ voter: voterId, option });
        polls[pollId].totalVotes++;
    }
    res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Chat Server running on port ${PORT}`));