// Autenticación local: hash scrypt + sesiones en SQLite.
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import db from "./db.js";

export function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return { hash, salt };
}
export function verifyPassword(pw, hash, salt) {
  try {
    const h = scryptSync(pw, salt, 64);
    const stored = Buffer.from(hash, "hex");
    return h.length === stored.length && timingSafeEqual(h, stored);
  } catch {
    return false;
  }
}
// Consume tiempo similar cuando el email NO existe (evita user enumeration por timing).
const DUMMY = hashPassword("dummy-timing-password");
export function dummyVerify(pw) { try { scryptSync(pw || "", DUMMY.salt, 64); } catch {} return false; }

export function userCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
}
export function getUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").toLowerCase());
}
export function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}
export function createUser({ email, name, password, role = "owner" }) {
  const { hash, salt } = hashPassword(password);
  const info = db
    .prepare("INSERT INTO users (email, name, pass_hash, pass_salt, role, created_at) VALUES (?,?,?,?,?,?)")
    .run(String(email).toLowerCase(), name || "", hash, salt, role, new Date().toISOString());
  return getUserById(info.lastInsertRowid);
}

export function createSession(userId, days = 30) {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)").run(
    token, userId, new Date(now).toISOString(), new Date(now + days * 864e5).toISOString()
  );
  return token;
}
export function deleteSession(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
export function userFromToken(token) {
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) { deleteSession(token); return null; }
  const u = getUserById(s.user_id);
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

export function updateUser(id, { name, email }) {
  db.prepare("UPDATE users SET name = ?, email = ? WHERE id = ?").run(name || "", String(email).toLowerCase(), id);
  return getUserById(id);
}
export function updatePassword(id, newPw) {
  const { hash, salt } = hashPassword(newPw);
  db.prepare("UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?").run(hash, salt, id);
}

export const publicUser = (u) => (u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null);
