// reminders.js — $0 reminders: .ics calendar file, best-effort local notification, app badge.
// buildICS / shouldNotify are pure and node-testable; the rest touch browser APIs defensively.
import { pad2, localDateStr } from './util.js';

const CRLF = '\r\n';

function icsEscape(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Fold a content line to <= 75 octets (RFC 5545 §3.1), never splitting a UTF-8 char. */
export function foldLine(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = '', curLen = 0, limit = 75;
  for (const ch of line) {
    const l = enc.encode(ch).length;
    if (curLen + l > limit) {
      parts.push(cur);
      cur = ''; curLen = 0; limit = 74; // continuation lines start with a space
    }
    cur += ch; curLen += l;
  }
  parts.push(cur);
  return parts.join(CRLF + ' ');
}

function utcStamp(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T` +
    `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

/**
 * buildICS({ time:'20:00', startDate:'YYYY-MM-DD', url, now:Date }) -> string (CRLF line endings)
 * DTSTART is a floating local time (no TZID, no Z) so it fires at that wall-clock time wherever you are.
 */
export function buildICS({ time = '20:00', startDate = localDateStr(), url = '', now = new Date(),
  title = '話し日記 — speak today’s entry', durationMin = 10 } = {}) {
  const [hh, mm] = String(time).split(':').map((x) => parseInt(x, 10) || 0);
  const ymd = startDate.replace(/-/g, '');
  const startMin = hh * 60 + mm;
  const endMin = Math.min(startMin + durationMin, 23 * 60 + 59);
  const dtStart = `${ymd}T${pad2(hh)}${pad2(mm)}00`;
  const dtEnd = `${ymd}T${pad2(Math.floor(endMin / 60))}${pad2(endMin % 60)}00`;
  const desc = `Open Hanashi Nikki and record at least a minute of Japanese.${url ? '\n' + url : ''}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hanashi Nikki//Daily reminder//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:hanashi-nikki-daily-${ymd}-${pad2(hh)}${pad2(mm)}@hanashi-nikki`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    'RRULE:FREQ=DAILY',
    `SUMMARY:${icsEscape(title)}`,
    `DESCRIPTION:${icsEscape(desc)}`,
    ...(url ? [`URL:${icsEscape(url)}`] : []),
    'TRANSP:TRANSPARENT',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape('話し日記: time to speak today’s entry')}`,
    'TRIGGER:PT0M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** Trigger a download of the .ics file. */
export function downloadICS(opts) {
  const text = buildICS(opts);
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'hanashi-nikki-reminder.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Pure decision: should a reminder notification be shown now? */
export function shouldNotify({ now = new Date(), reminderTime = '20:00', todayDone = false,
  permission = 'default', lastNotifiedDate = null } = {}) {
  if (todayDone || permission !== 'granted') return false;
  const today = localDateStr(now);
  if (lastNotifiedDate === today) return false;
  const [hh, mm] = String(reminderTime || '20:00').split(':').map((x) => parseInt(x, 10) || 0);
  return now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm;
}

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator;
}

export async function requestNotificationPermission() {
  if (!notificationsSupported()) return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return 'denied'; }
}

const LAST_KEY = 'hn-last-notified';

/**
 * Call on app open / visibilitychange. Shows a notification through the SW registration
 * if it's past reminderTime, no qualifying entry today, and permission is granted.
 */
export async function checkReminder({ reminderTime, todayDone }) {
  updateBadge(todayDone);
  if (!notificationsSupported()) return false;
  let last = null;
  try { last = localStorage.getItem(LAST_KEY); } catch { /* private mode */ }
  const ok = shouldNotify({ now: new Date(), reminderTime, todayDone,
    permission: Notification.permission, lastNotifiedDate: last });
  if (!ok) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification('話し日記', {
      body: 'まだ今日の日記を話していませんよ。1分だけ話しましょう！ (No entry yet today)',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: 'hn-daily',
      data: { url: './#/today' },
    });
    try { localStorage.setItem(LAST_KEY, localDateStr()); } catch { /* ignore */ }
    return true;
  } catch (e) {
    console.warn('notification failed', e);
    return false;
  }
}

export async function setAppBadge(n = 1) {
  try { if (navigator.setAppBadge) await navigator.setAppBadge(n); } catch { /* unsupported */ }
}
export async function clearAppBadge() {
  try { if (navigator.clearAppBadge) await navigator.clearAppBadge(); } catch { /* unsupported */ }
}
export function updateBadge(todayDone) {
  return todayDone ? clearAppBadge() : setAppBadge(1);
}
