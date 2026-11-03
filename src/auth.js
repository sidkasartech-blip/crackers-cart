'use strict';
const crypto = require('node:crypto');

const SESSION_DAYS = 7;
const COOKIE = 'cc_admin';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

async function createSession(db, res, secure) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  await db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  await db.run('INSERT INTO sessions (token, expires_at) VALUES (?, ?)', [token, expires]);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

async function destroySession(db, req, res) {
  const token = readCookie(req, COOKIE);
  if (token) await db.run('DELETE FROM sessions WHERE token = ?', [token]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

async function isAuthed(db, req) {
  const token = readCookie(req, COOKIE);
  if (!token) return false;
  const row = await db.get('SELECT expires_at FROM sessions WHERE token = ?', [token]);
  return !!row && row.expires_at > Date.now();
}

function requireAdmin(db) {
  return async (req, res, next) => {
    if (await isAuthed(db, req)) return next();
    res.status(401).json({ error: 'Please log in' });
  };
}

module.exports = { hashPassword, verifyPassword, createSession, destroySession, isAuthed, requireAdmin };
