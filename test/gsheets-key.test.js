'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const createGSheets = require('../lib/gsheets');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const key = { type: 'service_account', client_email: 'bot@proj.iam.gserviceaccount.com', private_key: privateKey };
const st = env => createGSheets({ env }).status();

test('the Google key is accepted as one line, with escaped or real line breaks, in quotes, or as base64; a broken one is said to be invalid', () => {
  const oneLine = JSON.stringify(key);
  assert.equal(st({ GOOGLE_SERVICE_ACCOUNT_JSON: oneLine }).configured, true);
  assert.equal(st({ GOOGLE_SERVICE_ACCOUNT_JSON: `  ${oneLine}\n` }).configured, true, 'stray spaces and a final newline');
  assert.equal(st({ GOOGLE_SERVICE_ACCOUNT_JSON: `'${oneLine}'` }).configured, true, 'wrapped in quotes');
  const pretty = JSON.stringify(key, null, 2).replace(/\\n/g, '\n');   // the key file pasted with real line breaks inside the private key
  assert.equal(st({ GOOGLE_SERVICE_ACCOUNT_JSON: pretty }).configured, true, 'real line breaks inside the key');
  assert.equal(st({ GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(oneLine).toString('base64') }).configured, true, 'pasted as base64');
  assert.match(st({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email": "x"' }).error, /not valid JSON/);
  assert.match(st({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'x' }) }).error, /missing its client_email or private_key/);
});
