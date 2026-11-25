import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { departments, slots } from './seed.mjs'

const env = process.env
const db = new DatabaseSync(env.DATABASE_PATH || 'bookings.sqlite')
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS departments (name TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS slots (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS bookings (
    department TEXT PRIMARY KEY REFERENCES departments(name),
    slot TEXT NOT NULL UNIQUE REFERENCES slots(id)
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department TEXT NOT NULL, slot TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0
  );
`)
for (const name of departments) db.prepare('INSERT OR IGNORE INTO departments VALUES (?)').run(name)
for (const id of slots) db.prepare('INSERT OR IGNORE INTO slots VALUES (?)').run(id)

const pending = db.prepare('SELECT * FROM notifications WHERE sent = 0 ORDER BY id LIMIT 20')
let sending = false
async function notify() {
  if (sending || !env.RESEND_API_KEY || !env.MAIL_FROM || !env.MAIL_TO) return
  sending = true
  try {
    for (const item of pending.all()) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `wards-2027-${item.id}`,
        },
        body: JSON.stringify({
          from: env.MAIL_FROM, to: [env.MAIL_TO],
          subject: `שיבוץ לתכניות עבודה 2027 | ${item.department}`,
          text: `${item.department} בחרה מועד להצגת תכנית העבודה.\n${item.slot.replace('T', ' בשעה ')} (שעון ישראל).\nאפשר לשלוח למחלקה זימון ליומן.`,
        }),
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error(`Email service returned ${response.status}`)
      db.prepare('UPDATE notifications SET sent = 1 WHERE id = ?').run(item.id)
    }
  } catch (error) {
    console.error(error.message)
  } finally {
    sending = false
  }
}
setInterval(notify, 30000).unref()

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}
async function body(req) {
  let data = ''
  for await (const chunk of req.setEncoding('utf8')) {
    data += chunk
    if (data.length > 4096) throw new Error('Invalid body')
  }
  const value = JSON.parse(data)
  if (!value || typeof value !== 'object') throw new Error('Invalid body')
  return value
}
const digest = value => createHash('sha256').update(value).digest()
function admin(req) {
  return env.ADMIN_KEY && timingSafeEqual(digest(req.headers.authorization || ''), digest(`Bearer ${env.ADMIN_KEY}`))
}
function availability() {
  return {
    departments: db.prepare('SELECT name FROM departments WHERE name NOT IN (SELECT department FROM bookings) ORDER BY rowid').all().map(row => row.name),
    slots: db.prepare('SELECT id FROM slots WHERE id NOT IN (SELECT slot FROM bookings) ORDER BY id').all().map(row => row.id),
  }
}
function booking(department, slot, asAdmin) {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (asAdmin) {
      db.prepare('DELETE FROM bookings WHERE department = ?').run(department)
    }
    if (slot !== null || !asAdmin) {
      db.prepare('INSERT INTO bookings VALUES (?, ?)').run(department, slot)
      if (!asAdmin) db.prepare('INSERT INTO notifications (department, slot) VALUES (?, ?)').run(department, slot)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const page = readFileSync(new URL('./index.html', import.meta.url))
createServer(async (req, res) => {
  const route = req.url?.split('?')[0]
  const method = req.method
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  try {
    if (method === 'GET' && (route === '/' || route === '/admin')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(page)
    }
    if (method === 'GET' && route === '/api/availability') return json(res, 200, availability())
    if (route?.startsWith('/api/admin') && !admin(req)) return json(res, 401, { error: 'נדרשת סיסמת ניהול תקינה.' })
    if (method === 'GET' && route === '/api/admin') {
      return json(res, 200, {
        ...availability(),
        bookings: db.prepare('SELECT * FROM bookings ORDER BY slot').all(),
      })
    }
    if (method === 'POST' && route === '/api/admin/departments') {
      const { name } = await body(req)
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) return json(res, 400, { error: 'יש להזין שם מחלקה.' })
      const result = db.prepare('INSERT OR IGNORE INTO departments VALUES (?)').run(name.trim())
      return result.changes ? json(res, 201, {}) : json(res, 409, { error: 'המחלקה כבר קיימת.' })
    }
    if (method === 'POST' && (route === '/api/book' || route === '/api/admin/book')) {
      const { department, slot } = await body(req)
      const asAdmin = route === '/api/admin/book'
      if (typeof department !== 'string' || !(typeof slot === 'string' || (asAdmin && slot === null))) {
        return json(res, 400, { error: 'יש לבחור מחלקה ומועד.' })
      }
      booking(department, slot, asAdmin)
      void notify()
      return json(res, 200, { department, slot })
    }
    return json(res, 404, { error: 'העמוד לא נמצא.' })
  } catch (error) {
    if (error.errcode && (error.errcode & 255) === 19) {
      return json(res, 409, { error: 'המועד או המחלקה כבר שובצו, או שהבחירה אינה זמינה. הרשימה תתעדכן.' })
    }
    if (error instanceof SyntaxError || error.message === 'Invalid body') return json(res, 400, { error: 'הבקשה אינה תקינה.' })
    console.error(error)
    return json(res, 500, { error: 'אירעה תקלה. אפשר לנסות שוב.' })
  }
}).listen(Number(env.PORT || 3000), env.HOST || '0.0.0.0')
