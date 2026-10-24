// ============================================================
// auth.js — Trial / Pro access layer for LazyShift
// Replace SUPABASE_URL and SUPABASE_ANON_KEY with your values
// (must match what's in app.js and login.html)
// ============================================================

const AUTH_SUPABASE_URL      = 'https://tmkrbnkztmohfoohbgfy.supabase.co'
const AUTH_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRta3Jibmt6dG1vaGZvb2hiZ2Z5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NzEwMDYsImV4cCI6MjA5NzA0NzAwNn0.3cs4A3nLk8jIEfo4byWpPiJrf59qnli1QiKeM7GiB8I'

// ── Pro checkout switch ─────────────────────────────────────
// The single place the Lemon Squeezy checkout is turned on. While false,
// every page shows "Pro: coming soon", startCheckout() does nothing and
// nothing links to Lemon Squeezy. Set to true to sell Pro: the "Upgrade to
// Pro" buttons appear and call startCheckout().
const CHECKOUT_ENABLED = false
const CHECKOUT_URL     = 'https://lazyshift.lemonsqueezy.com/checkout/buy/7bfac24a-c2e4-4b0d-a790-5782b48b28b3'

;(function () {
  const { createClient } = window.supabase
  const authSb = createClient(AUTH_SUPABASE_URL, AUTH_SUPABASE_ANON_KEY)

  // Set when a checkout tab is opened; while it's recent, coming back to
  // this tab refetches the profile so the purchase unlocks without a reload.
  const CHECKOUT_STARTED_KEY = 'lazyshift-checkout-started'
  const CHECKOUT_WATCH_MS    = 2 * 60 * 60 * 1000

  let resolveReady
  const ready = new Promise(resolve => { resolveReady = resolve })

  const Auth = {
    user:    null,   // Supabase auth user
    profile: null,   // row from public.users
    profileFromCache: false, // true when offline and profile came from localStorage
    ready,           // resolves once the initial session (and profile) is known
    checkoutEnabled: CHECKOUT_ENABLED,

    // ── Public API ──────────────────────────────────────────

    getUserStatus() {
      if (!this.user) return 'guest'
      const { is_pro, premium_expires, trial_ends_at } = this.profile || {}
      // premium_expires is set by the webhook (renewal date + grace, or
      // ends_at once cancelled) — past it, Pro no longer counts even if an
      // expiry webhook was missed. Offline it's checked against the local
      // clock on the cached copy.
      if (is_pro && (!premium_expires || new Date(premium_expires) > new Date())) return 'pro'
      if (trial_ends_at && new Date(trial_ends_at) > new Date()) return 'trial'
      return 'expired'
    },

    getAccessLevel() {
      const status = this.getUserStatus()
      if (status === 'guest')   return { canAccessAll: false, isPro: false, isTrialActive: false, trialDaysLeft: 0, loggedIn: false }
      if (status === 'pro')     return { canAccessAll: true,  isPro: true,  isTrialActive: false, trialDaysLeft: 0, loggedIn: true }
      if (status === 'trial') {
        const trialDaysLeft = Math.ceil((new Date(this.profile.trial_ends_at) - new Date()) / 86400000)
        return { canAccessAll: true, isPro: false, isTrialActive: true, trialDaysLeft, loggedIn: true }
      }
      return { canAccessAll: false, isPro: false, isTrialActive: false, trialDaysLeft: 0, loggedIn: true }
    },

    // Call before a premium action. If not allowed, shows the upgrade overlay.
    // Returns true if allowed, false if blocked.
    requirePremium(reason) {
      const access = this.getAccessLevel()
      if (access.canAccessAll) return true
      showUpgradeOverlay(access, reason)
      return false
    },

    // Opens the Lemon Squeezy checkout prefilled with the account email and
    // the user id (meta.custom_data.user_id in the webhook), so the payment
    // is matched to this account even if another email is used to pay.
    // Guests sign in first. Does nothing while CHECKOUT_ENABLED is false.
    async startCheckout() {
      if (!CHECKOUT_ENABLED) return
      await this.ready
      if (!this.user) {
        window.location.href = '/login.html?next=upgrade'
        return
      }
      const url = new URL(CHECKOUT_URL)
      url.searchParams.set('checkout[email]', this.user.email)
      url.searchParams.set('checkout[custom][user_id]', this.user.id)

      try { sessionStorage.setItem(CHECKOUT_STARTED_KEY, String(Date.now())) } catch {}
      const win = window.open(url.toString(), '_blank')
      if (win) win.opener = null
      else window.location.href = url.toString() // popup blocked
    },

    // Re-reads public.users (e.g. after a purchase) and re-applies access.
    async refreshProfile() {
      if (!this.user || !navigator.onLine) return
      const { data } = await authSb
        .from('users')
        .select('*')
        .eq('id', this.user.id)
        .single()
      if (!data) return
      saveCachedProfile(this.user.id, data)
      this.profile = data
      this.profileFromCache = false
      this._applyAccess()
    },

    // ── Internal ────────────────────────────────────────────

    _applyAccess() {
      applyAccessRestrictions()
      updateTrialBanner()
      if (typeof window.updatePushSettingsUI === 'function') window.updatePushSettingsUI()
    },

    // Offline: the user from the session supabase-js keeps in
    // localStorage. With an expired access token it can't refresh offline
    // and reports no session, but keeps it and refreshes once back online.
    offlineUser() {
      if (navigator.onLine) return null
      try { return JSON.parse(localStorage.getItem(SB_STORAGE_KEY))?.user || null } catch { return null }
    },

    async _getOrCreateProfile(user) {
      this.profileFromCache = false
      // Offline, don't wait for supabase-js to retry: use the last
      // profile seen on this device.
      if (!navigator.onLine) {
        const cached = readCachedProfile(user.id)
        this.profileFromCache = !!cached
        return cached
      }

      let data, error, status
      try {
        ({ data, error, status } = await authSb
          .from('users')
          .select('*')
          .eq('id', user.id)
          .single())
      } catch (e) {
        error = e
        status = 0
      }

      if (data) {
        saveCachedProfile(user.id, data)
        return data
      }

      // Create a trial only when Supabase says there is no row (PGRST116).
      // Any other failure (no network = status 0, expired token, ...): use
      // the last profile seen on this device.
      if (!error || error.code !== 'PGRST116') {
        const cached = readCachedProfile(user.id)
        this.profileFromCache = !!cached
        return cached
      }

      // First login — create record with 30-day trial
      const trialEnds = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data: created } = await authSb
        .from('users')
        .insert({ id: user.id, email: user.email, trial_ends_at: trialEnds })
        .select()
        .single()

      if (created) saveCachedProfile(user.id, created)
      return created || null
    },

    async _onSignIn(user) {
      this.user    = user
      this.profile = await this._getOrCreateProfile(user)
      this._applyAccess()
    },

    _onSignOut() {
      this.user    = null
      this.profile = null
      this._applyAccess()
    },

    init() {
      // Offline, supabase-js retries the token refresh for a long time
      // before its first event: show the stored user right away.
      const stored = this.offlineUser()
      if (stored) this._onSignIn(stored).then(resolveReady)

      authSb.auth.onAuthStateChange(async (event, session) => {
        const user = session?.user || (event !== 'SIGNED_OUT' ? this.offlineUser() : null)
        if (user) {
          await this._onSignIn(user)
        } else {
          if (event === 'SIGNED_OUT') clearCachedProfile()
          this._onSignOut()
        }
        resolveReady()
      })
      watchForPurchase()

      // Back online after using the cached profile: read it again.
      window.addEventListener('online', async () => {
        if (!this.user || !this.profileFromCache) return
        const { data } = await authSb.auth.getSession()
        if (data.session?.user) await this._onSignIn(data.session.user)
      })
    }
  }

  // ── Unlock after checkout ────────────────────────────────
  // The webhook updates public.users a few seconds after payment. Pick it
  // up (a) when the user returns to this tab after opening checkout, and
  // (b) on ?upgraded=1 — the Lemon Squeezy confirmation button links back
  // to the app with it — by polling until Pro shows up.

  function checkoutRecentlyStarted() {
    try {
      const t = Number(sessionStorage.getItem(CHECKOUT_STARTED_KEY))
      return t > 0 && Date.now() - t < CHECKOUT_WATCH_MS
    } catch { return false }
  }

  async function pollUntilPro(attempts, intervalMs) {
    for (let i = 0; i < attempts && Auth.getUserStatus() !== 'pro'; i++) {
      await Auth.refreshProfile()
      if (Auth.getUserStatus() === 'pro') break
      await new Promise(r => setTimeout(r, intervalMs))
    }
    if (Auth.getUserStatus() === 'pro') {
      try { sessionStorage.removeItem(CHECKOUT_STARTED_KEY) } catch {}
      const overlay = document.getElementById('upgrade-overlay')
      if (overlay) overlay.style.display = 'none'
    }
  }

  function dropQueryParam(params, name) {
    params.delete(name)
    const qs = params.toString()
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash)
  }

  function watchForPurchase() {
    if (!CHECKOUT_ENABLED) return

    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || !checkoutRecentlyStarted()) return
      await Auth.ready
      if (Auth.user && Auth.getUserStatus() !== 'pro') pollUntilPro(4, 3000)
    })

    const params = new URLSearchParams(window.location.search)
    if (params.has('upgraded')) {
      dropQueryParam(params, 'upgraded')
      Auth.ready.then(() => { if (Auth.user) pollUntilPro(20, 3000) })
    }

    // Arriving from login.html?next=upgrade: show the upgrade options again.
    if (params.has('upgrade')) {
      dropQueryParam(params, 'upgrade')
      Auth.ready.then(() => {
        if (Auth.user && Auth.getUserStatus() !== 'pro' && document.getElementById('upgrade-overlay')) {
          window.openUpgradeOverlay()
        }
      })
    }
  }

  // Shows either the "Upgrade to Pro" buttons ([data-checkout]) or the
  // "Pro: coming soon" ones ([data-coming-soon]), per CHECKOUT_ENABLED.
  function applyCheckoutSwitch() {
    document.querySelectorAll('[data-checkout]').forEach(el => {
      el.style.display = CHECKOUT_ENABLED ? 'block' : 'none'
    })
    document.querySelectorAll('[data-coming-soon]').forEach(el => {
      el.style.display = CHECKOUT_ENABLED ? 'none' : ''
    })
  }

  window.startCheckout = () => Auth.startCheckout()

  window.Auth = Auth

  // ── Last known profile (offline fallback) ────────────────
  // Only the fields access depends on, for one user at a time.

  const PROFILE_KEY = 'lazyshift-profile'
  // Where supabase-js stores the session (its default storage key).
  const SB_STORAGE_KEY = 'sb-' + new URL(AUTH_SUPABASE_URL).hostname.split('.')[0] + '-auth-token'

  function saveCachedProfile(userId, p) {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify({
        id:              userId,
        is_pro:          !!p.is_pro,
        trial_ends_at:   p.trial_ends_at || null,
        premium_expires: p.premium_expires || null,
      }))
    } catch {}
  }

  function readCachedProfile(userId) {
    try {
      const p = JSON.parse(localStorage.getItem(PROFILE_KEY))
      return p && p.id === userId ? p : null
    } catch { return null }
  }

  function clearCachedProfile() {
    try { localStorage.removeItem(PROFILE_KEY) } catch {}
  }

  // ── Upgrade Overlay ──────────────────────────────────────

  function showUpgradeOverlay(access, reason) {
    // Pro already has everything: there is nothing to upgrade to.
    if (access.isPro) return

    let title, subtitle

    if (!access.loggedIn) {
      title    = 'Sign in to continue'
      subtitle = 'Create a free account and get 30 days of full access — no credit card required.'
    } else if (access.isTrialActive) {
      const days = `${access.trialDaysLeft} day${access.trialDaysLeft !== 1 ? 's' : ''}`
      title    = 'LazyShift Pro'
      subtitle = CHECKOUT_ENABLED
        ? `Your free trial has ${days} left, with everything below included. Upgrade to Pro to keep it afterwards.`
        : `Your free trial has ${days} left, with everything below included. Pro is coming soon.`
    } else if (CHECKOUT_ENABLED) {
      title    = 'Your trial has ended'
      subtitle = reason === 'month'
        ? 'Upgrade to Pro to view any month of the year and keep your full schedule.'
        : 'Upgrade to Pro for unlimited PDF exports and full year access.'
    } else {
      title    = 'Your trial has ended'
      subtitle = reason === 'month'
        ? 'Pro, with any month of the year and your full schedule, is coming soon.'
        : 'Pro, with unlimited PDF exports and full year access, is coming soon.'
    }

    // The free trial is offered only to guests.
    const offerTrial = !access.loggedIn
    document.getElementById('upgrade-trial-btn').style.display  = offerTrial ? 'block' : 'none'
    document.getElementById('upgrade-trial-note').style.display = offerTrial ? '' : 'none'

    document.getElementById('upgrade-title').textContent    = title
    document.getElementById('upgrade-subtitle').textContent = subtitle
    document.getElementById('upgrade-overlay').style.display = 'flex'
  }

  // Banner link: the overlay for the current status.
  window.openUpgradeOverlay = function () {
    showUpgradeOverlay(Auth.getAccessLevel())
  }

  window.closeUpgradeOverlay = function () {
    document.getElementById('upgrade-overlay').style.display = 'none'
  }

  // ── Apply access restrictions to existing app functions ──

  function applyAccessRestrictions() {
    const access = Auth.getAccessLevel()

    // Patch changeMonth — block if limited access and trying to leave current month
    window._changeMonth = window._changeMonth || window.changeMonth
    window.changeMonth = function (dir) {
      if (access.canAccessAll) {
        window._changeMonth(dir)
        return
      }
      // Allow if result is still current month
      const today = new Date()
      const targetMonth = viewMonth + dir
      const targetYear  = targetMonth < 0 ? viewYear - 1 : targetMonth > 11 ? viewYear + 1 : viewYear
      const normalizedMonth = ((targetMonth % 12) + 12) % 12
      if (targetYear === today.getFullYear() && normalizedMonth === today.getMonth()) {
        window._changeMonth(dir)
      } else {
        showUpgradeOverlay(access, 'month')
      }
    }

    // Patch tryExportPdf — block if limited access
    window._tryExportPdf = window._tryExportPdf || window.tryExportPdf
    window.tryExportPdf = function () {
      if (access.canAccessAll) {
        window._tryExportPdf()
      } else {
        showUpgradeOverlay(access, 'pdf')
      }
    }
  }

  // ── Trial banner in app header ───────────────────────────

  function updateTrialBanner() {
    const banner = document.getElementById('trial-banner')
    if (!banner) return

    const access = Auth.getAccessLevel()

    if (!access.loggedIn) {
      banner.style.display = 'flex'
      banner.style.background = 'rgba(74,222,128,0.05)'
      banner.style.borderColor = 'rgba(74,222,128,0.15)'
      banner.innerHTML = `
        <span style="color:#7a9a7a;">📅 Sign in for a <strong style="color:#ccc;">30-day free trial</strong> — full year view, PDF exports, salary calculator.</span>
        <a href="#" onclick="openAuth(); return false"
           style="color:#4ade80; font-weight:700; text-decoration:none; font-size:12px; white-space:nowrap; margin-left:12px;">Sign in →</a>
      `
      return
    }

    if (access.isPro) {
      banner.style.display = 'none'
      const overlay = document.getElementById('upgrade-overlay')
      if (overlay) overlay.style.display = 'none'
      return
    }

    if (access.isTrialActive) {
      banner.style.display = 'flex'
      banner.innerHTML = `
        <span>🎁 Free trial · <strong>${access.trialDaysLeft} day${access.trialDaysLeft !== 1 ? 's' : ''} left</strong></span>
        <a href="#" onclick="openUpgradeOverlay(); return false"
           style="color:#4ade80; font-weight:700; text-decoration:none; font-size:12px;">See Pro →</a>
      `
      return
    }

    // Trial expired
    banner.style.display = 'flex'
    banner.style.background = 'rgba(248,113,113,0.12)'
    banner.style.borderColor = 'rgba(248,113,113,0.3)'
    banner.innerHTML = `
      <span>⏰ Trial ended · limited access</span>
      <a href="#" onclick="openUpgradeOverlay(); return false"
         style="color:#f87171; font-weight:700; text-decoration:none; font-size:12px;">See Pro →</a>
    `
  }

  // ── Boot ─────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    applyCheckoutSwitch()
    Auth.init()
    applyAccessRestrictions()
    updateTrialBanner()
  })

})()
