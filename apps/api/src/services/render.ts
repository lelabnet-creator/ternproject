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
  maintenanceScheduled: string
  maintenanceStarted: string
  maintenanceCompleted: string
  maintenanceCancelled: string
  maintenanceReminder: string
  viewStatus: string
  unsubscribe: string
}

const EN: Strings = {
  opened: 'Incident opened',
  updated: 'Incident update',
  resolved: 'Incident resolved',
  postmortem: 'Postmortem published',
  maintenanceScheduled: 'Maintenance scheduled',
  maintenanceStarted: 'Maintenance started',
  maintenanceCompleted: 'Maintenance completed',
  maintenanceCancelled: 'Maintenance cancelled',
  maintenanceReminder: 'Upcoming maintenance',
  viewStatus: 'View status page',
  unsubscribe: 'Unsubscribe',
}

const FR: Strings = {
  opened: 'Incident ouvert',
  updated: 'Mise à jour d’incident',
  resolved: 'Incident résolu',
  postmortem: 'Analyse post-incident publiée',
  maintenanceScheduled: 'Maintenance planifiée',
  maintenanceStarted: 'Maintenance démarrée',
  maintenanceCompleted: 'Maintenance terminée',
  maintenanceCancelled: 'Maintenance annulée',
  maintenanceReminder: 'Maintenance à venir',
  viewStatus: 'Voir la page de statut',
  unsubscribe: 'Se désabonner',
}

const PREFIXES: Record<string, keyof Strings> = {
  'incident.opened': 'opened',
  'incident.updated': 'updated',
  'incident.resolved': 'resolved',
  'incident.postmortem': 'postmortem',
  'maintenance.scheduled': 'maintenanceScheduled',
  'maintenance.started': 'maintenanceStarted',
  'maintenance.completed': 'maintenanceCompleted',
  'maintenance.cancelled': 'maintenanceCancelled',
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

/**
 * The password reset message.
 *
 * Written in the account's own language, and deliberately terse: the only two
 * things it has to carry are the link and the fact that ignoring it is safe.
 * No name, no tenant, no logo — this mail is sent to an address someone typed
 * into a public form, and everything it says about the account is something an
 * attacker learns for free.
 */
export function renderPasswordReset(locale: string, resetUrl: string, ttlMinutes: number) {
  const fr = locale.startsWith('fr')

  const subject = fr ? 'Réinitialiser votre mot de passe' : 'Reset your password'
  const lead = fr
    ? 'Quelqu’un a demandé la réinitialisation du mot de passe de ce compte TERN.'
    : 'Someone asked to reset the password for this TERN account.'
  const action = fr ? 'Choisir un nouveau mot de passe' : 'Choose a new password'
  const expiry = fr
    ? `Ce lien expire dans ${ttlMinutes} minutes et ne fonctionne qu’une fois.`
    : `This link expires in ${ttlMinutes} minutes and works only once.`
  const ignore = fr
    ? 'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.'
    : 'If you did not ask for this, ignore this message — your password is unchanged.'

  const text = [lead, '', `${action}: ${resetUrl}`, '', expiry, '', ignore].join('\n')

  // Same rules as the notification mail above: no images, no remote CSS, no
  // tracking pixel. The URL is printed as well as linked, because a client that
  // strips the anchor should still leave something the reader can copy.
  const html = [
    `<p>${escapeHtml(lead)}</p>`,
    `<p><a href="${escapeHtml(resetUrl)}">${escapeHtml(action)}</a></p>`,
    `<p style="font-size:12px;color:#666">${escapeHtml(resetUrl)}</p>`,
    `<p>${escapeHtml(expiry)}</p>`,
    `<p style="font-size:12px;color:#666">${escapeHtml(ignore)}</p>`,
  ].join('\n')

  return { subject, text, html }
}
