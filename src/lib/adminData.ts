import {
  adminAuditLog,
  adminDashboard,
  adminSettings,
  adminUploads,
  adminUsers,
  adminWebhookDeliveries,
  adminWebhooks,
  type AdminAuditEntry,
  type AdminDashboard,
  type AdminSettings,
  type AdminUpload,
  type AdminUser,
  type AdminWebhook,
  type WebhookDelivery,
} from './api'

export interface AdminDataSnapshot {
  dashboard: AdminDashboard
  users: AdminUser[]
  uploads: AdminUpload[]
  settings: AdminSettings
  webhooks: AdminWebhook[]
  deliveries: WebhookDelivery[]
  audit: AdminAuditEntry[]
}

let cached: AdminDataSnapshot | null = null
let inflight: Promise<AdminDataSnapshot> | null = null

export function peekAdminData(): AdminDataSnapshot | null {
  return cached
}

export function loadAdminData(force = false): Promise<AdminDataSnapshot> {
  if (!force && cached) return Promise.resolve(cached)
  if (inflight) return inflight
  inflight = Promise.all([
    adminDashboard(), adminUsers(), adminUploads(), adminSettings(),
    adminWebhooks(), adminWebhookDeliveries(), adminAuditLog(),
  ]).then(([dashboard, users, uploads, settings, webhooks, deliveries, audit]) => {
    cached = { dashboard, users, uploads, settings, webhooks, deliveries, audit }
    return cached
  }).finally(() => { inflight = null })
  return inflight
}
