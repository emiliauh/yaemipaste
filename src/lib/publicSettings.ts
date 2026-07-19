import { computed, readonly, ref } from 'vue'
import { adminPublicSettings, applyRuntimePublicSettings, type PublicAdminSettings } from './api'

const FALLBACK_SETTINGS: PublicAdminSettings = {
  app_name: 'yaemipaste',
  public_title: 'yaemipaste',
  registration_enabled: true,
  base_api_url: '',
  turnstile_site_key: '',
  turnstile_required: false,
  file_size_limit_bytes: 0,
  file_size_limit_unlimited: false,
  upload_access_mode: 'private',
}

const publicSettings = ref<PublicAdminSettings>({ ...FALLBACK_SETTINGS })
let loaded = false
let inflight: Promise<PublicAdminSettings> | null = null

function applyDocumentTitle(settings: PublicAdminSettings) {
  if (typeof document === 'undefined') return
  const title = settings.public_title?.trim() || settings.app_name?.trim() || FALLBACK_SETTINGS.public_title
  document.title = title
}

export function usePublicSettings() {
  async function refreshPublicSettings(force = false): Promise<PublicAdminSettings> {
    if (loaded && !force) return publicSettings.value
    if (inflight) return inflight
    inflight = adminPublicSettings()
      .then((settings) => {
        publicSettings.value = {
          ...FALLBACK_SETTINGS,
          ...settings,
          app_name: settings.app_name?.trim() || FALLBACK_SETTINGS.app_name,
          public_title: settings.public_title?.trim() || settings.app_name?.trim() || FALLBACK_SETTINGS.public_title,
        }
        applyRuntimePublicSettings(publicSettings.value)
        loaded = true
        applyDocumentTitle(publicSettings.value)
        return publicSettings.value
      })
      .catch(() => {
        loaded = true
        applyDocumentTitle(publicSettings.value)
        return publicSettings.value
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  return {
    publicSettings: readonly(publicSettings),
    appName: computed(() => publicSettings.value.app_name || FALLBACK_SETTINGS.app_name),
    publicTitle: computed(() => publicSettings.value.public_title || publicSettings.value.app_name || FALLBACK_SETTINGS.public_title),
    refreshPublicSettings,
  }
}
