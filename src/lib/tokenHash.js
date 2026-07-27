const crypto = require('crypto');

// Shared by password-reset and invite tokens: raw token goes out over
// email, only its hash is ever persisted. A DB leak alone can't be used
// to act on a pending reset/invite — the raw token was only ever
// transmitted over the (assumed-private) email channel.
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { hashToken, generateRawToken };
