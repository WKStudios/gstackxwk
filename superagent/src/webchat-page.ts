/** The web chat UI — one self-contained page, no build step. */

export function webChatPage(agentName: string): string {
  const name = agentName.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${name}</title>
<style>
  :root { --bg:#f4f1ec; --panel:#ffffff; --me:#d9fdd3; --them:#ffffff; --ink:#111b21; --muted:#667781; --accent:#00a884; --line:#e4e0da; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b141a; --panel:#111b21; --me:#005c4b; --them:#202c33; --ink:#e9edef; --muted:#8696a0; --accent:#00a884; --line:#222d34; } }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { background: var(--bg); color: var(--ink); font: 15px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; }
  header { background: var(--panel); border-bottom: 1px solid var(--line); padding: 12px 16px; display: flex; align-items: center; gap: 10px; }
  header .dot { width: 34px; height: 34px; border-radius: 50%; background: var(--accent); color: #fff; display: grid; place-items: center; font-weight: 600; }
  header .title { font-weight: 600; } header .sub { color: var(--muted); font-size: 12px; }
  #log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 6px; }
  .msg { max-width: min(80%, 640px); padding: 7px 10px 6px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; box-shadow: 0 1px 0.5px rgba(0,0,0,.13); }
  .me { align-self: flex-end; background: var(--me); } .them { align-self: flex-start; background: var(--them); }
  .meta { color: var(--muted); font-size: 11px; margin-top: 2px; text-align: right; }
  .msg code { font-family: ui-monospace, Menlo, monospace; font-size: 13px; background: rgba(127,127,127,.15); padding: 0 3px; border-radius: 3px; }
  .msg a { color: var(--accent); }
  .buttons { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .buttons button { border: 1px solid var(--accent); color: var(--accent); background: transparent; border-radius: 16px; padding: 5px 12px; font: inherit; cursor: pointer; }
  .buttons button:disabled { opacity: .45; cursor: default; }
  .typing { color: var(--muted); font-size: 13px; padding: 0 16px 6px; min-height: 20px; }
  form { background: var(--panel); border-top: 1px solid var(--line); padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); display: flex; gap: 8px; align-items: flex-end; }
  textarea { flex: 1; resize: none; border: 1px solid var(--line); border-radius: 20px; padding: 9px 14px; font: inherit; color: var(--ink); background: var(--bg); max-height: 160px; }
  .icon { border: 0; background: transparent; color: var(--muted); font-size: 22px; cursor: pointer; padding: 6px; }
  .send { background: var(--accent); color: #fff; border-radius: 50%; width: 42px; height: 42px; font-size: 18px; }
  .file-chip { font-size: 12px; color: var(--muted); padding: 0 16px 4px; }
</style>
</head>
<body>
<header><div class="dot">${name.slice(0, 1).toUpperCase()}</div><div><div class="title">${name}</div><div class="sub" id="status">connecting…</div></div></header>
<div id="log" aria-live="polite"></div>
<div class="file-chip" id="chip"></div>
<form id="form">
  <label class="icon" title="Attach a file">📎<input id="file" type="file" hidden></label>
  <textarea id="text" rows="1" placeholder="Message" autocomplete="off"></textarea>
  <button class="icon send" type="submit" aria-label="Send">➤</button>
</form>
<script>
const log = document.getElementById('log'), form = document.getElementById('form'), input = document.getElementById('text');
const fileInput = document.getElementById('file'), chip = document.getElementById('chip'), statusEl = document.getElementById('status');
function esc(s) { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function render(md) {
  let h = esc(md || '');
  h = h.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, (m, c) => '<code>' + c + '</code>');
  h = h.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
  h = h.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<b>$1</b>').replace(/(^|\\s)\\*([^*\\n]+)\\*/g, '$1<b>$2</b>').replace(/(^|\\s)_([^_\\n]+)_/g, '$1<i>$2</i>');
  h = h.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/(^|[\\s(])(https?:\\/\\/[^\\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return h;
}
function time(at) { return new Date(at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function add(who, text, at, extra) {
  const el = document.createElement('div');
  el.className = 'msg ' + who;
  el.innerHTML = render(text) + (extra || '') + '<div class="meta">' + time(at) + '</div>';
  log.appendChild(el); log.scrollTop = log.scrollHeight;
  return el;
}
async function send(payload) {
  const isForm = payload instanceof FormData;
  const res = await fetch('/chat/send', { method: 'POST', body: isForm ? payload : JSON.stringify(payload), headers: isForm ? {} : { 'Content-Type': 'application/json' } });
  if (!res.ok) add('them', '⚠️ ' + (await res.text()));
}
form.addEventListener('submit', async e => {
  e.preventDefault();
  const text = input.value.trim(); const file = fileInput.files[0];
  if (!text && !file) return;
  add('me', (file ? '📎 ' + file.name + (text ? '\\n' : '') : '') + text);
  input.value = ''; input.style.height = ''; chip.textContent = ''; fileInput.value = '';
  if (file) { const fd = new FormData(); fd.append('text', text); fd.append('file', file); await send(fd); }
  else await send({ text });
});
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });
fileInput.addEventListener('change', () => { chip.textContent = fileInput.files[0] ? '📎 ' + fileInput.files[0].name : ''; });
fetch('/chat/history').then(r => r.json()).then(rows => {
  for (const r of rows) add(r.speaker === 'user' ? 'me' : 'them', r.text, r.created_at);
});
function connect() {
  const es = new EventSource('/chat/events');
  es.onopen = () => statusEl.textContent = 'online';
  es.onerror = () => { statusEl.textContent = 'reconnecting…'; };
  es.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type === 'buttons') {
      const el = add('them', m.text, m.at, '<div class="buttons">' + m.buttons.map(b => '<button data-id="' + esc(b.id) + '">' + esc(b.title) + '</button>').join('') + '</div>');
      el.querySelectorAll('button').forEach(btn => btn.onclick = () => {
        el.querySelectorAll('button').forEach(b => b.disabled = true);
        add('me', btn.textContent); send({ buttonId: btn.dataset.id, text: btn.textContent });
      });
    } else if (m.type === 'media') {
      const preview = m.kind === 'image' ? '<br><img src="' + esc(m.url) + '" style="max-width:100%;border-radius:6px">' :
        m.kind === 'audio' ? '<br><audio controls src="' + esc(m.url) + '"></audio>' : '';
      add('them', (m.text ? m.text + '\\n' : '') + '📎 ' + m.filename, m.at, preview + '<br><a href="' + esc(m.url) + '" target="_blank" rel="noopener">Open</a>');
    } else add('them', m.text, m.at);
  };
}
connect();
</script>
</body>
</html>`;
}
