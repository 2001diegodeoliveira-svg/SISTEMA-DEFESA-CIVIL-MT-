'use strict';

const crypto = require('node:crypto');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function encryptionKey(value = process.env.MFA_ENCRYPTION_KEY) {
  if (!/^[a-fA-F0-9]{64}$/.test(String(value || ''))) {
    throw new Error('MFA_ENCRYPTION_KEY deve conter 64 caracteres hexadecimais (32 bytes).');
  }
  return Buffer.from(value, 'hex');
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(secret) {
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of String(secret || '').toUpperCase().replace(/=+$/g, '')) {
    const digit = BASE32.indexOf(char);
    if (digit < 0) throw new Error('Segredo TOTP inválido.');
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function createSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function totp(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 1000 / STEP_SECONDS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(code).padStart(6, '0');
}

function verifyTotp(secret, code, timestamp = Date.now()) {
  return verifyTotpStep(secret, code, timestamp) !== null;
}

function verifyTotpStep(secret, code, timestamp = Date.now(), lastVerifiedStep = -1) {
  const candidate = String(code || '');
  if (!/^\d{6}$/.test(candidate)) return null;
  const supplied = Buffer.from(candidate);
  const currentStep = Math.floor(timestamp / 1000 / STEP_SECONDS);
  for (let offset = -1; offset <= 1; offset++) {
    const step = currentStep + offset;
    if (step <= lastVerifiedStep) continue;
    const expected = Buffer.from(totp(secret, step * STEP_SECONDS * 1000));
    if (crypto.timingSafeEqual(supplied, expected)) return step;
  }
  return null;
}

function encryptSecret(secret, keyValue) {
  const key = encryptionKey(keyValue);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptSecret(encrypted, keyValue) {
  const key = encryptionKey(keyValue);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(encrypted.nonce, 'base64')
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function otpauthUri(secret, username) {
  const issuer = 'SGI%20PROTEGE';
  const label = encodeURIComponent(`SGI PROTEGE:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

module.exports = {
  createSecret,
  decryptSecret,
  encryptSecret,
  otpauthUri,
  totp,
  verifyTotp,
  verifyTotpStep,
};
