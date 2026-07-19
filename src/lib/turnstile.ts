import './promiseWithResolvers'
import { ref } from 'vue'

type TurnstileWidgetId = string | number

interface TurnstileRenderOptions {
  sitekey: string
  appearance?: 'always' | 'execute' | 'interaction-only'
  callback?: (token: string) => void
  'expired-callback'?: () => void
  'error-callback'?: (errorCode?: string) => void
}

interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => TurnstileWidgetId
  execute: (id: TurnstileWidgetId) => void
  reset: (id: TurnstileWidgetId) => void
  remove: (id: TurnstileWidgetId) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const SCRIPT_LOAD_TIMEOUT_MS = 10_000
const TOKEN_WAIT_TIMEOUT_MS = 8_000
const POLL_INTERVAL_MS = 100

// Cloudflare error codes that mean "this deployment is misconfigured" rather
// than "retry might help" - see https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/.
// Turnstile itself already auto-retries transient network failures before
// ever calling error-callback, so anything reaching us here has either
// exhausted those retries or is one of these permanent errors.
const UNRECOVERABLE_ERROR_PREFIXES = ['110200', '110420', '110421', '110422']

function isUnrecoverable(errorCode?: string): boolean {
  if (!errorCode) return false
  return UNRECOVERABLE_ERROR_PREFIXES.some((prefix) => errorCode.startsWith(prefix))
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false
    await delay(POLL_INTERVAL_MS)
  }
  return true
}

let scriptLoadPromise: Promise<void> | null = null

async function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return
  if (scriptLoadPromise) return scriptLoadPromise
  const run = async () => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-turnstile]')
    if (existing) {
      const ready = await waitUntil(() => !!window.turnstile, SCRIPT_LOAD_TIMEOUT_MS)
      if (!ready) throw new Error('Security check failed to initialize.')
      return
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    script.dataset.turnstile = '1'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Security check failed to load. Check your connection and reload.'))
    document.head.appendChild(script)
    await promise
  }
  scriptLoadPromise = run().catch((error) => {
    scriptLoadPromise = null
    throw error
  })
  return scriptLoadPromise
}

/**
 * Manages a single Cloudflare Turnstile widget instance. Renders with
 * `appearance: 'interaction-only'` so the challenge runs in the background
 * for the common case and only becomes visible when Cloudflare actually
 * needs the visitor to interact, per Cloudflare's documented pattern for
 * unobtrusive verification.
 */
export function useTurnstile() {
  const token = ref('')
  const widgetId = ref<TurnstileWidgetId | null>(null)
  const fatalError = ref('')

  async function mount(container: HTMLElement, siteKey: string): Promise<void> {
    if (!siteKey || !container || widgetId.value != null) return
    await loadTurnstileScript()
    if (!window.turnstile) return
    widgetId.value = window.turnstile.render(container, {
      sitekey: siteKey,
      appearance: 'interaction-only',
      callback: (value: string) => {
        token.value = value
        fatalError.value = ''
      },
      'expired-callback': () => {
        token.value = ''
      },
      'error-callback': (errorCode?: string) => {
        token.value = ''
        if (isUnrecoverable(errorCode)) {
          fatalError.value = 'The security check is not configured for this domain. Contact the site administrator.'
        }
        // Otherwise Turnstile has already exhausted its own auto-retry;
        // leave the widget in place so the visitor can retry manually.
      },
    })
  }

  function reset() {
    if (window.turnstile && widgetId.value != null) window.turnstile.reset(widgetId.value)
    token.value = ''
    fatalError.value = ''
  }

  function destroy() {
    if (window.turnstile && widgetId.value != null) window.turnstile.remove(widgetId.value)
    widgetId.value = null
    token.value = ''
  }

  /**
   * Resolves the current token, waiting briefly for the background
   * verification to complete if the widget is mounted but hasn't produced a
   * token yet (e.g. the visitor submitted the form the instant the page
   * loaded). Throws a user-facing message if it never arrives.
   */
  async function ensureToken(siteKey: string): Promise<string> {
    if (!siteKey) return ''
    if (fatalError.value) throw new Error(fatalError.value)
    if (!window.turnstile || widgetId.value == null) throw new Error('Security check is not ready yet. Please wait a moment and try again.')
    if (!token.value) {
      // Ask Turnstile to promote the interaction-only widget into its visible
      // challenge when the background pass did not produce a token. Without
      // this call the form could only report an error while the challenge
      // remained hidden in privacy-focused browsers.
      window.turnstile.execute(widgetId.value)
      const arrived = await waitUntil(() => !!token.value || !!fatalError.value, TOKEN_WAIT_TIMEOUT_MS)
      if (fatalError.value) throw new Error(fatalError.value)
      if (!arrived || !token.value) throw new Error('User verification failed.')
    }
    return token.value
  }

  return { token, fatalError, mount, reset, destroy, ensureToken }
}
