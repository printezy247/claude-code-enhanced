// Mic button: record, send the audio to the local engine in main, append the text.
import { toast } from '../app/core.js';
import { t } from '../i18n.js';

const MAX_MS = 60000;

function toBase64(blob) {
  return blob.arrayBuffer().then((buf) => {
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
}

export function wireDictation(chat) {
  const btn = chat.micBtn;
  if (!btn) return;
  let rec = null, stream = null, timer = null, busy = false;
  const release = () => {
    clearTimeout(timer);
    if (stream) stream.getTracks().forEach((tr) => tr.stop());
    stream = null; rec = null;
    btn.classList.remove('rec');
    btn.setAttribute('aria-pressed', 'false');
  };
  const finish = async (chunks) => {
    release();
    busy = true; btn.disabled = true;
    try {
      const audio = await toBase64(new Blob(chunks));
      const r = await ccx.invoke('dictation:transcribe', { audio });
      if (!r || !r.ok) { toast((r && r.error) || t('dictate.fail'), 'err'); return; }
      if (r.text) chat.composer.value = (chat.composer.value ? chat.composer.value.replace(/\s*$/, ' ') : '') + r.text;
      chat.composer.dispatchEvent(new Event('input', { bubbles: true }));
      chat.composer.focus();
    } finally { busy = false; btn.disabled = false; }
  };
  btn.addEventListener('click', async () => {
    if (busy) return;
    if (rec) { rec.stop(); return; }
    const st = await ccx.invoke('dictation:status');
    if (!st || !st.ready) { toast(t('dictate.missing'), 'err'); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { toast(t('dictate.noMic'), 'err'); return; }
    const chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => finish(chunks);
    rec.start();
    btn.classList.add('rec');
    btn.setAttribute('aria-pressed', 'true');
    timer = setTimeout(() => { if (rec) rec.stop(); }, MAX_MS);
  });
}
