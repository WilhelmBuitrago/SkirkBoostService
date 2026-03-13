const crypto = require('crypto');
const argon2 = require('argon2');

function createSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function withPepper(password, salt) {
  const pepper = process.env.PEPPER;
  if (!pepper) {
    throw new Error('PEPPER env var is required.');
  }
  return `${password}${salt}${pepper}`;
}

async function hashPassword(password) {
  const salt = createSalt();
  const hash = await argon2.hash(withPepper(password, salt), { type: argon2.argon2id });
  return { hash, salt };
}

async function verifyPassword(password, salt, hash) {
  return argon2.verify(hash, withPepper(password, salt));
}

module.exports = {
  hashPassword,
  verifyPassword
};
