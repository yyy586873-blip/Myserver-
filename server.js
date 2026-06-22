const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { Client } = require('ssh2');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws) => {
  let ssh = null;
  let shell = null;

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      return;
    }

    if (data.type === 'connect') {
      if (ssh) return;

      const host = data.host;
      const port = Number(data.port || 22);
      const username = 'madmax';
      const password = 'Madmax';

      ssh = new Client();

      ssh.on('ready', () => {
        ssh.shell((err, stream) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'error', data: err.message }));
            ssh.end();
            ssh = null;
            return;
          }

          shell = stream;
          ws.send(JSON.stringify({ type: 'status', data: 'connected' }));

          stream.on('data', (chunk) => {
            ws.send(JSON.stringify({ type: 'output', data: chunk.toString('utf8') }));
          });

          stream.on('close', () => {
            ws.send(JSON.stringify({ type: 'status', data: 'closed' }));
            if (ssh) ssh.end();
            ssh = null;
            shell = null;
          });
        });
      });

      ssh.on('error', (err) => {
        ws.send(JSON.stringify({ type: 'error', data: err.message }));
        ssh = null;
        shell = null;
      });

      ssh.connect({
        host,
        port,
        username,
        password
      });
    }

    if (data.type === 'input' && shell) {
      shell.write(data.data);
    }

    if (data.type === 'resize' && shell) {
      const cols = Number(data.cols || 80);
      const rows = Number(data.rows || 24);
      shell.setWindow(rows, cols, 0, 0);
    }
  });

  ws.on('close', () => {
    if (shell) shell.close();
    if (ssh) ssh.end();
  });
});

server.listen(process.env.PORT || 3000, '0.0.0.0');
