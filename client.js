const hostEl = document.getElementById('host');
const portEl = document.getElementById('port');
const connectBtn = document.getElementById('connect');
const clearBtn = document.getElementById('clear');
const statusEl = document.getElementById('status');
const terminalEl = document.getElementById('terminal');
const cmdEl = document.getElementById('cmd');

let ws = null;

function addLine(text) {
  terminalEl.textContent += text;
  terminalEl.scrollTop = terminalEl.scrollHeight;
}

connectBtn.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(`${location.origin.replace('http', 'ws')}/ws`);

  ws.onopen = () => {
    statusEl.textContent = 'Connecting...';
    ws.send(JSON.stringify({
      type: 'connect',
      host: hostEl.value.trim(),
      port: portEl.value.trim()
    }));
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'status') {
      statusEl.textContent = msg.data;
      addLine(`
[${msg.data}]
`);
    }

    if (msg.type === 'output') {
      addLine(msg.data);
    }

    if (msg.type === 'error') {
      statusEl.textContent = 'Error';
      addLine(`
[ERROR] ${msg.data}
`);
    }
  };

  ws.onclose = () => {
    statusEl.textContent = 'Disconnected';
    addLine('
[disconnected]
');
  };
};

cmdEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data: cmdEl.value + '
' }));
    cmdEl.value = '';
  }
});

clearBtn.onclick = () => {
  terminalEl.textContent = '';
};
