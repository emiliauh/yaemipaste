<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
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
import { isAuthEnabled } from '../lib/features'

const router = useRouter()
const route = useRoute()
const TURNSTILE_SITE_KEY = (
  import.meta.env.VITE_TURNSTILE_SITE_KEY
  ?? ''
).trim()

// mode: 'account' = username+password, 'token' = raw token (legacy)
const mode = ref<'account' | 'token'>('account')

const username = ref('')
const password = ref('')
const token = ref('')
const error = ref('')
const status = ref('')
const loading = ref(false)
const passkeyLoading = ref(false)
const rememberMe = ref(getRememberPreference())
const showPassword = ref(false)
const tokenUsed = ref(false)
const turnstileContainer = ref<HTMLElement | null>(null)
const turnstileToken = ref('')
const turnstileWidgetId = ref<string | number | null>(null)
let restoreBodyOverflow = ''
let restoreHtmlOverflow = ''

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
  status.value = ''
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
  if (!isAuthEnabled()) {
    router.replace('/files')
    return
  }
  restoreBodyOverflow = document.body.style.overflow
  restoreHtmlOverflow = document.documentElement.style.overflow
  document.body.style.overflow = 'hidden'
  document.documentElement.style.overflow = 'hidden'
  if (route.query.registered === '1') {
    mode.value = 'account'
    const registeredUsername = typeof route.query.username === 'string' ? route.query.username : ''
    if (registeredUsername) username.value = registeredUsername
    status.value = 'Account created. Complete the security check to log in.'
  }
  void mountTurnstile().catch((e: any) => {
    setError(e?.message ?? 'Security check failed to load')
  })
})

onBeforeUnmount(() => {
  document.body.style.overflow = restoreBodyOverflow
  document.documentElement.style.overflow = restoreHtmlOverflow
})

async function submit() {
  setError('')
  status.value = ''
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
    resetTurnstileToken()
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
      <div class="auth-brand">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32">
            <path d="M8 9.5h16"/>
            <path d="M8 16h16"/>
            <path d="M8 22.5h10"/>
          </svg>
        </span>
        <div>
          <p>yaemipaste</p>
          <h1>Sign in to your paste workspace</h1>
        </div>
      </div>
      <div class="info-box login-info">
        <span class="icon">ⓘ</span>
        <span>
          Authentication required<br>
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
              <div class="password-wrap">
                <input
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="current-password"
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  class="password-toggle"
                  :aria-label="showPassword ? 'Hide password' : 'Show password'"
                  :title="showPassword ? 'Hide password' : 'Show password'"
                  @click="showPassword = !showPassword"
                >
                  <svg v-if="showPassword" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M3 3l18 18"/>
                    <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/>
                    <path d="M9.9 4.2A10.8 10.8 0 0 1 12 4c5.3 0 9.5 4.2 10.5 8-.4 1.6-1.5 3.3-3 4.8"/>
                    <path d="M6.2 6.2C4.3 7.7 2.9 9.8 2 12c1 3.8 5.2 8 10 8 1 0 2-.2 2.9-.5"/>
                  </svg>
                  <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M2 12s3.8-8 10-8 10 8 10 8-3.8 8-10 8-10-8-10-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                </button>
              </div>
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

          <div v-if="status" class="status-msg">{{ status }}</div>

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
  padding: 26px 16px;
}
.center {
  width: min(430px, 100%);
  display: flex;
  flex-direction: column;
  align-items: stretch;
}
.auth-brand {
  display: flex;
  gap: 14px;
  align-items: center;
  margin-bottom: 18px;
}
.brand-mark {
  width: 46px;
  height: 46px;
  border: 1px solid var(--border);
  border-radius: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--surface2) 88%, var(--accent-soft));
  color: var(--accent);
  box-shadow: 0 12px 28px color-mix(in srgb, var(--shadow) 22%, transparent);
  flex: 0 0 auto;
}
.brand-mark svg {
  width: 23px;
  height: 23px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
}
.auth-brand p {
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 2px;
}
.auth-brand h1 {
  color: var(--text);
  font-size: clamp(25px, 8vw, 34px);
  line-height: 0.98;
  letter-spacing: 0;
  text-wrap: balance;
}
.login-info { width: 100%; margin-bottom: 14px; }
.login-card { width: 100%; }
.login-tabs { width: 100%; margin-bottom: 16px; }
.login-tabs button { flex: 1; }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 13px; }
.field label { color: var(--text); font-size: 12px; font-weight: 600; }
.field-hint { color: var(--text3); font-size: 11px; margin-top: -2px; }
.field input { width: 100%; }
.password-wrap {
  position: relative;
}
.password-wrap input {
  padding-right: 36px;
}
.password-toggle {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 24px;
  border: 0;
  background: transparent;
  color: var(--text3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.password-toggle:hover {
  color: var(--text);
}
.remember-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text2);
  font-size: 12px;
  margin: 2px 0 10px;
  user-select: none;
}
.remember-toggle input { margin-top: 1px; }
.turnstile-container {
  margin-bottom: 10px;
}
.form-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
.status-msg {
  color: var(--green);
  font-size: 12px;
  margin-bottom: 10px;
}
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
.link { color: var(--text2); font-size: 12px; font-weight: 600; text-decoration: none; }
.link:hover { color: var(--text); }

@media (max-width: 420px) {
  .page { padding: 12px; }
  .card { padding: 16px; }
}
</style>
