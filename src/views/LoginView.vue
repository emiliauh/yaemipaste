<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  authLogin,
  authPasskeyLoginBegin,
  authPasskeyLoginFinish,
  authTokenStatus,
  getRememberPreference,
  loginWithToken,
  setRememberPreference,
} from '../lib/api'
import { credentialToJson, isPasskeySupported, toRequestOptions } from '../lib/passkeys'

const router = useRouter()
const runtimeHost = typeof window !== 'undefined' ? window.location.hostname : ''
const TURNSTILE_FALLBACK_KEYS: Record<string, string> = {
  'example.invalid': 'TURNSTILE_SITE_KEY',
  'example.invalid': 'TURNSTILE_SITE_KEY',
}
const TURNSTILE_SITE_KEY = (
  import.meta.env.VITE_TURNSTILE_SITE_KEY
  ?? TURNSTILE_FALLBACK_KEYS[runtimeHost]
  ?? ''
).trim()

// mode: 'account' = username+password, 'token' = raw token (legacy)
const mode = ref<'account' | 'token'>('account')

const username = ref('')
const password = ref('')
const token = ref('')
const error = ref('')
const loading = ref(false)
const passkeyLoading = ref(false)
const rememberMe = ref(getRememberPreference())
const tokenUsed = ref(false)
const turnstileContainer = ref<HTMLElement | null>(null)
const turnstileToken = ref('')
const turnstileWidgetId = ref<string | number | null>(null)

type TurnstileWidgetId = string | number
interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => TurnstileWidgetId
  execute: (id: TurnstileWidgetId) => void
  reset: (id: TurnstileWidgetId) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

watch(rememberMe, (value) => setRememberPreference(value))
watch(mode, () => {
  error.value = ''
  tokenUsed.value = false
})

function setError(message: string, usedToken = false) {
  error.value = message
  tokenUsed.value = usedToken
}

async function ensureTurnstileToken(): Promise<string> {
  if (!TURNSTILE_SITE_KEY) return ''
  if (!window.turnstile || turnstileWidgetId.value == null) throw new Error('Security check is not ready.')
  if (!turnstileToken.value) throw new Error('Please complete the security check before logging in.')
  return turnstileToken.value
}

function resetTurnstileToken() {
  if (!TURNSTILE_SITE_KEY || !window.turnstile || turnstileWidgetId.value == null) return
  window.turnstile.reset(turnstileWidgetId.value)
  turnstileToken.value = ''
}

async function mountTurnstile() {
  if (!TURNSTILE_SITE_KEY || !turnstileContainer.value) return
  if (!document.querySelector('script[data-turnstile]')) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      script.defer = true
      script.dataset.turnstile = '1'
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Security check failed to load'))
      document.head.appendChild(script)
    })
  } else if (!window.turnstile) {
    await new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const check = () => {
        if (window.turnstile) resolve()
        else if (Date.now() - start > 5_000) reject(new Error('Security check failed to initialize'))
        else setTimeout(check, 50)
      }
      check()
    })
  }
  if (!window.turnstile || turnstileWidgetId.value != null) return
  turnstileWidgetId.value = window.turnstile.render(turnstileContainer.value, {
    sitekey: TURNSTILE_SITE_KEY,
    callback: (tokenValue: string) => {
      turnstileToken.value = tokenValue
    },
    'expired-callback': () => {
      turnstileToken.value = ''
    },
    'error-callback': () => {
      turnstileToken.value = ''
      setError('Security check failed. Reload and try again.')
    },
  })
}

function goToAccountLogin() {
  mode.value = 'account'
}

onMounted(() => {
  void mountTurnstile().catch((e: any) => {
    setError(e?.message ?? 'Security check failed to load')
  })
})

async function submit() {
  setError('')
  loading.value = true
  try {
    if (mode.value === 'account') {
      const captchaToken = await ensureTurnstileToken()
      await authLogin(username.value.trim(), password.value, {
        rememberMe: rememberMe.value,
        turnstileToken: captchaToken,
      })
      resetTurnstileToken()
    } else {
      if (!token.value.trim()) throw new Error('Token is required')
      const status = await authTokenStatus(token.value.trim())
      if (status === 'used') {
        setError('Token already used.', true)
        return
      }
      if (status === 'invalid') throw new Error('Invalid token')
      loginWithToken(token.value.trim(), rememberMe.value)
    }
    router.push('/files')
  } catch (e: any) {
    setError(e.message ?? 'Login failed')
  } finally {
    loading.value = false
  }
}

async function loginWithPasskey() {
  if (mode.value !== 'account') {
    setError('Passkeys are available in Account mode only')
    return
  }
  if (!username.value.trim()) {
    setError('Username is required for passkey login')
    return
  }
  if (!isPasskeySupported()) {
    setError('Passkeys are not supported in this browser')
    return
  }
  setError('')
  passkeyLoading.value = true
  try {
    const options = await authPasskeyLoginBegin(username.value.trim())
    const credential = await navigator.credentials.get({ publicKey: toRequestOptions(options) })
    if (!(credential instanceof PublicKeyCredential)) throw new Error('Could not read passkey credential')
    await authPasskeyLoginFinish(username.value.trim(), credentialToJson(credential), rememberMe.value)
    router.push('/files')
  } catch (e: any) {
    setError(e.message ?? 'Passkey login failed')
  } finally {
    passkeyLoading.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="center" data-testid="login-center">
      <div class="info-box login-info">
        <span class="icon">ⓘ</span>
        <span>
          Authentication Required<br>
          <span style="color:var(--text3)">Sign in with your account, or enter a token directly.</span>
        </span>
      </div>

      <div class="card login-card">
        <div class="tabs login-tabs">
          <button :class="{ active: mode === 'account' }" @click="mode = 'account'">Account</button>
          <button :class="{ active: mode === 'token' }" @click="mode = 'token'">Token</button>
        </div>

        <form @submit.prevent="submit">
          <template v-if="mode === 'account'">
            <div class="field">
              <label>Username</label>
              <input v-model="username" type="text" autocomplete="username" autofocus placeholder="username" required />
            </div>
            <div class="field">
              <label>Password</label>
              <input v-model="password" type="password" autocomplete="current-password" placeholder="••••••••" required />
            </div>
          </template>

          <template v-else>
            <div class="field">
              <label>Auth Token</label>
              <p class="field-hint">Your token will be stored on your device until you logout.</p>
              <input v-model="token" type="text" autocomplete="off" autofocus placeholder="enter token" required />
            </div>
          </template>

          <label class="remember-toggle">
            <input v-model="rememberMe" type="checkbox" />
            <span>remember me</span>
          </label>

          <div v-if="TURNSTILE_SITE_KEY" ref="turnstileContainer" class="turnstile-container"></div>

          <div v-if="error" class="error-msg">
            <span>{{ error }}</span>
            <button v-if="tokenUsed" type="button" class="inline-link" @click="goToAccountLogin">Do you have an account?</button>
          </div>

          <div class="form-footer">
            <button type="submit" class="btn-primary" :disabled="loading">
              {{ loading ? 'Logging in…' : 'Login' }}
            </button>
            <button
              v-if="mode === 'account'"
              type="button"
              class="btn-ghost"
              data-testid="passkey-login-btn"
              :disabled="loading || passkeyLoading || !username.trim()"
              @click="loginWithPasskey"
            >
              {{ passkeyLoading ? 'Waiting for passkey…' : 'Use passkey' }}
            </button>
            <router-link v-if="mode === 'account'" to="/register" class="link">Register</router-link>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  padding: 16px;
}
.center {
  width: min(400px, 100%);
  display: flex;
  flex-direction: column;
  align-items: stretch;
}
.login-info { width: 100%; margin-bottom: 16px; }
.login-card { width: 100%; }
.login-tabs { width: 100%; margin-bottom: 16px; }
.login-tabs button { flex: 1; }
.field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.field label { color: var(--text); font-size: 12px; }
.field-hint { color: var(--text3); font-size: 11px; margin-top: -2px; }
.field input { width: 100%; }
.remember-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text2);
  font-size: 12px;
  margin: 2px 0 10px;
  user-select: none;
}
.remember-toggle input {
  appearance: none;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--border2);
  border-radius: 2px;
  background: var(--bg);
  display: inline-block;
  flex-shrink: 0;
  position: relative;
}
.remember-toggle input:checked {
  border-color: var(--accent);
  background: var(--checked-bg);
}
.remember-toggle input:checked::after {
  content: "";
  position: absolute;
  inset: 2px;
  background: var(--accent);
  border-radius: 1px;
}
.turnstile-container {
  margin-bottom: 10px;
}
.form-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
.error-msg {
  color: var(--red-h);
  font-size: 12px;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.inline-link {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text2);
  padding: 2px 8px;
  font-size: 11px;
}
.inline-link:hover {
  border-color: var(--text3);
  color: var(--text);
}
.link { color: var(--text2); font-size: 12px; text-decoration: none; }
.link:hover { color: var(--text); }

@media (max-width: 420px) {
  .page { padding: 12px; }
  .card { padding: 16px; }
}
</style>
