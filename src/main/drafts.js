// Images pasted into a message that has not been sent yet, kept across a
// crash. They used to be dropped (only the text survived, in localStorage)
// because megabytes of base64 overflow localStorage and would sit there
// unencrypted for anything that reads the profile. Here they are files the
// user alone can read (0600 in a 0700 folder), named by a hash of the folder
// so the file name says nothing about the project.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_IMAGES = 8;
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function createDraftStore(dir) {
  const fileOf = (key) => path.join(dir, crypto.createHash('sha256').update(String(key || '')).digest('hex').slice(0, 32) + '.json');
  const ensureDir = () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  };
  const clean = (images) => (Array.isArray(images) ? images : [])
    .filter((i) => i && IMAGE_TYPE.test(String(i.media_type)) && typeof i.data === 'string' && BASE64.test(i.data))
    .slice(0, MAX_IMAGES)
    .map((i) => ({ media_type: i.media_type, data: i.data }));

  return {
    save(key, images) {
      const list = clean(images);
      const f = fileOf(key);
      if (!list.length) { try { fs.unlinkSync(f); } catch { /* none */ } return; }
      ensureDir();
      const tmp = f + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
      fs.renameSync(tmp, f);
    },
    load(key) {
      try { return clean(JSON.parse(fs.readFileSync(fileOf(key), 'utf8'))); } catch { return []; }
    },
  };
}

module.exports = { createDraftStore };
