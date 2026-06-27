// ============================================================
// auth.js — Trial / Pro access layer for LazyShift
// Replace SUPABASE_URL and SUPABASE_ANON_KEY with your values
// (must match what's in app.js and login.html)
// ============================================================

const AUTH_SUPABASE_URL      = 'https://gtgjwriutlyhvfoyucsq.supabase.co'
const AUTH_SUPABASE_ANON_KEY = 'sb_publishable_X_FP_x4U_Fj54ImuOFXOGQ_V2x6iKOv'

;(function () {
  const { createClient } = window.supabase
  const authSb = createClient(AUTH_SUPABASE_URL, AUTH_SUPABASE_ANON_KEY)

  const Auth = {
    user:    null,   // Supabase auth user
    profile: null,   // row from public.users

    // ── Public API ──────────────────────────────────────────

    getAccessLevel() {
      if (!this.user) return { canAccessAll: false, isPro: false, isTrialActive: false, trialDaysLeft: 0, loggedIn: false }

      const { is_pro, trial_ends_at } = this.profile || {}
      if (is_pro) return { canAccessAll: true, isPro: true, isTrialActive: false, trialDaysLeft: 0, loggedIn: true }

      const trialEnds = trial_ends_at ? new Date(trial_ends_at) : null
      const now = new Date()
      const isTrialActive = trialEnds && trialEnds > now
      const trialDaysLeft = isTrialActive ? Math.ceil((trialEnds - now) / 86400000) : 0

      return {
        canAccessAll: isTrialActive,
        isPro: false,
        isTrialActive,
        trialDaysLeft,
        loggedIn: true,
      }
    },

    // Call before a premium action. If not allowed, shows the upgrade overlay.
    // Returns true if allowed, false if blocked.
    requirePremium(reason) {
      const access = this.getAccessLevel()
      if (access.canAccessAll) return true
      showUpgradeOverlay(access, reason)
      return false
    },

    // ── Internal ────────────────────────────────────────────

    async _getOrCreateProfile(user) {
      const { data, error } = await authSb
        .from('users')
        .select('*')
        .eq('id', user.id)
        .single()

      if (data) return data

      // First login — create record with 30-day trial
      const trialEnds = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data: created } = await authSb
        .from('users')
        .insert({ id: user.id, email: user.email, trial_ends_at: trialEnds })
        .select()
        .single()

      return created || null
    },

    async _onSignIn(user) {
      this.user    = user
      this.profile = await this._getOrCreateProfile(user)
      applyAccessRestrictions()
      updateTrialBanner()
    },

    _onSignOut() {
      this.user    = null
      this.profile = null
      applyAccessRestrictions()
      updateTrialBanner()
    },

    init() {
      authSb.auth.onAuthStateChange(async (event, session) => {
        if (session?.user) {
          await this._onSignIn(session.user)
        } else {
          this._onSignOut()
        }
      })
    }
  }

  window.Auth = Auth

  // ── Upgrade Overlay ──────────────────────────────────────

  function showUpgradeOverlay(access, reason) {
    let title, subtitle

    if (!access.loggedIn) {
      title    = 'Sign in to continue'
      subtitle = 'Create a free account and get 30 days of full access — no credit card required.'
    } else {
      title    = 'Your trial has ended'
      subtitle = reason === 'month'
        ? 'Upgrade to Pro to view any month of the year and keep your full schedule.'
        : 'Upgrade to Pro for unlimited PDF exports and full year access.'
    }

    document.getElementById('upgrade-title').textContent    = title
    document.getElementById('upgrade-subtitle').textContent = subtitle
    document.getElementById('upgrade-overlay').style.display = 'flex'
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
      banner.style.display = 'none'
      return
    }

    if (access.isPro) {
      banner.style.display = 'none'
      return
    }

    if (access.isTrialActive) {
      banner.style.display = 'flex'
      banner.innerHTML = `
        <span>🎁 Free trial · <strong>${access.trialDaysLeft} day${access.trialDaysLeft !== 1 ? 's' : ''} left</strong></span>
        <a href="#" onclick="document.getElementById('upgrade-overlay').style.display='flex'; return false"
           style="color:#4ade80; font-weight:700; text-decoration:none; font-size:12px;">Upgrade →</a>
      `
      return
    }

    // Trial expired
    banner.style.display = 'flex'
    banner.style.background = 'rgba(248,113,113,0.12)'
    banner.style.borderColor = 'rgba(248,113,113,0.3)'
    banner.innerHTML = `
      <span>⏰ Trial ended · limited access</span>
      <a href="#" onclick="document.getElementById('upgrade-overlay').style.display='flex'; return false"
         style="color:#f87171; font-weight:700; text-decoration:none; font-size:12px;">Upgrade →</a>
    `
  }

  // ── Boot ─────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    Auth.init()
    applyAccessRestrictions()
  })

})()
