import type { schema } from '@tern/db'
import type { RenderedMessage } from './transports.js'
import { config } from '../config.js'

/**
 * Turns a queued event into the message a subscriber actually reads.
 *
 * Rendered in the subscriber's own language, not the tenant's: the person
 * reading is the one who has to understand it.
 */

type Notification = typeof schema.notifications.$inferSelect

interface Strings {
  opened: string
  updated: string
  resolved: string
  postmortem: string
  maintenanceStarted: string
  maintenanceCompleted: string
  maintenanceReminder: string
  viewStatus: string
  unsubscribe: string
}

const EN: Strings = {
  opened: 'Incident opened',
  updated: 'Incident update',
  resolved: 'Incident resolved',
  postmortem: 'Postmortem published',
  maintenanceStarted: 'Maintenance started',
  maintenanceCompleted: 'Maintenance completed',
  maintenanceReminder: 'Upcoming maintenance',
  viewStatus: 'View status page',
  unsubscribe: 'Unsubscribe',
}

const FR: Strings = {
  opened: 'Incident ouvert',
  updated: 'Mise à jour d’incident',
  resolved: 'Incident résolu',
  postmortem: 'Analyse post-incident publiée',
  maintenanceStarted: 'Maintenance démarrée',
  maintenanceCompleted: 'Maintenance terminée',
  maintenanceReminder: 'Maintenance à venir',
  viewStatus: 'Voir la page de statut',
  unsubscribe: 'Se désabonner',
}

const PREFIXES: Record<string, keyof Strings> = {
  'incident.opened': 'opened',
  'incident.updated': 'updated',
  'incident.resolved': 'resolved',
  'incident.postmortem': 'postmortem',
  'maintenance.started': 'maintenanceStarted',
  'maintenance.completed': 'maintenanceCompleted',
  'maintenance.reminder': 'maintenanceReminder',
}

export function renderNotification(
  notification: Notification,
  locale: string,
  unsubscribeUrl?: string,
): RenderedMessage {
  const s = locale.startsWith('fr') ? FR : EN
  const payload = notification.payload as { title?: string; body?: string }

  const kind = PREFIXES[notification.eventType]
  const prefix = kind ? s[kind] : notification.eventType
  const title = payload.title ?? ''
  const subject = title ? `[${prefix}] ${title}` : prefix

  const body = payload.body ?? ''
  const statusUrl = config.PUBLIC_BASE_URL

  const text = [
    body,
    '',
    `${s.viewStatus}: ${statusUrl}`,
    unsubscribeUrl ? `${s.unsubscribe}: ${unsubscribeUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  // Deliberately plain HTML: no images, no tracking pixel, no remote CSS.
  // Notification mail is read in a hurry, often on a phone, sometimes with
  // images blocked — and a status update has no business phoning home about
  // who opened it.
  const html = [
    `<p><strong>${escapeHtml(prefix)}</strong></p>`,
    title ? `<h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>` : '',
    body ? `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>` : '',
    `<p><a href="${escapeHtml(statusUrl)}">${escapeHtml(s.viewStatus)}</a></p>`,
    unsubscribeUrl
      ? `<p style="font-size:12px;color:#666"><a href="${escapeHtml(unsubscribeUrl)}">${escapeHtml(s.unsubscribe)}</a></p>`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  return { subject, text, html }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
