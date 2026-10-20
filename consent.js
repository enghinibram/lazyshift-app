// ============================================================
// consent.js — cookie banner + consent-gated Google Analytics
// Loaded in the <head> of every page. Google Consent Mode v2:
// everything defaults to "denied" and gtag.js itself is only
// downloaded after the visitor clicks Accept.
// ============================================================

// LazyShift's own GA4 property — the single place the ID is defined.
// [TODO: new GA4 measurement ID] Replace the placeholder with the
// measurement ID of the new LazyShift-only GA4 property (G-XXXXXXXXXX).
// While it is the placeholder, no analytics script is ever loaded.
const LAZYSHIFT_GA4_ID = 'G-XXXXXXXXXX'

;(function () {
  const STORAGE_KEY = 'cookie_consent'   // 'accepted' | 'rejected'
  const GA_CONFIGURED = /^G-[A-Z0-9]+$/.test(LAZYSHIFT_GA4_ID) && LAZYSHIFT_GA4_ID !== 'G-XXXXXXXXXX'

  // gtag stub: always defined, so any window.gtag(...) call is safe. With
  // consent denied and gtag.js not loaded, nothing leaves the browser.
  window.dataLayer = window.dataLayer || []
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments) }
  window.gtag('consent', 'default', {
    ad_storage:         'denied',
    ad_user_data:       'denied',
    ad_personalization: 'denied',
    analytics_storage:  'denied',
  })

  function readChoice() {
    try { return localStorage.getItem(STORAGE_KEY) } catch { return null }
  }
  function saveChoice(value) {
    try { localStorage.setItem(STORAGE_KEY, value) } catch {}
  }

  let gaLoaded = false
  function loadGA() {
    if (gaLoaded || !GA_CONFIGURED) return
    gaLoaded = true
    // Analytics only; advertising signals stay denied.
    window.gtag('consent', 'update', { analytics_storage: 'granted' })
    window.gtag('js', new Date())
    window.gtag('config', LAZYSHIFT_GA4_ID)
    const s = document.createElement('script')
    s.async = true
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + LAZYSHIFT_GA4_ID
    document.head.appendChild(s)
  }

  // Removes GA cookies (_ga, _ga_<id>) on this host and its parent domain.
  function clearGACookies() {
    const host = location.hostname
    const domains = ['', host, '.' + host.split('.').slice(-2).join('.')]
    document.cookie.split(';').forEach(c => {
      const name = c.split('=')[0].trim()
      if (!/^_ga/.test(name)) return
      domains.forEach(d => {
        document.cookie = name + '=; Max-Age=0; path=/' + (d ? '; domain=' + d : '')
      })
    })
  }

  function accept() {
    saveChoice('accepted')
    hideBanner()
    loadGA()
  }

  function reject() {
    const wasAccepted = readChoice() === 'accepted'
    saveChoice('rejected')
    hideBanner()
    window.gtag('consent', 'update', { analytics_storage: 'denied' })
    clearGACookies()
    // gtag.js may already be running on this page — a reload drops it.
    if (wasAccepted && gaLoaded) location.reload()
  }

  // ── Banner ───────────────────────────────────────────────

  const CSS = `
    #cookie-banner {
      display: none; position: fixed; bottom: 0; left: 0; right: 0;
      background: #1a1a2e; color: #f0f0f0; border-top: 2px solid #1D9E75;
      padding: 14px 20px; flex-wrap: wrap; align-items: center; gap: 12px;
      justify-content: space-between; z-index: 10002; font-size: 14px; line-height: 1.5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 -4px 20px rgba(0,0,0,0.3);
    }
    #cookie-banner .cookie-text { flex: 1 1 320px; }
    #cookie-banner a { color: #4ade80; text-decoration: underline; }
    #cookie-banner .cookie-actions { display: flex; gap: 8px; flex-shrink: 0; }
    #cookie-banner .cookie-btn {
      padding: 8px 18px; border-radius: 8px; border: none; cursor: pointer;
      font-size: 14px; font-weight: 600; font-family: inherit;
    }
    #cookie-banner .cookie-accept { background: #1D9E75; color: #fff; }
    #cookie-banner .cookie-reject { background: #1D9E75; color: #fff; }
    @media (max-width: 480px) {
      #cookie-banner { flex-direction: column; align-items: stretch; }
      #cookie-banner .cookie-btn { flex: 1; }
    }
    .site-footer {
      max-width: 760px; margin: 24px auto 0; padding: 16px 12px 24px;
      text-align: center; font-size: 13px; line-height: 2; color: #888;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .site-footer a, .site-footer button {
      color: inherit; text-decoration: underline; margin: 0 8px;
      background: none; border: none; padding: 0; font: inherit; cursor: pointer;
    }
    .site-footer a:hover, .site-footer button:hover { color: #1D9E75; }
    .legal-note { font-size: 12px; color: #888; text-align: center; margin: 8px 0 4px; line-height: 1.5; }
    .legal-note a { color: inherit; text-decoration: underline; }
  `

  function buildBanner() {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    const el = document.createElement('div')
    el.id = 'cookie-banner'
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-label', 'Cookie consent')
    el.innerHTML = `
      <div class="cookie-text">
        We'd like to use Google Analytics cookies to understand how LazyShift is used.
        They are only set if you accept. You can change your choice at any time via
        "Cookie settings" at the bottom of every page.
        <a href="/privacy.html#cookies">Privacy &amp; cookies</a>
      </div>
      <div class="cookie-actions">
        <button type="button" class="cookie-btn cookie-reject">Reject</button>
        <button type="button" class="cookie-btn cookie-accept">Accept</button>
      </div>`
    el.querySelector('.cookie-accept').addEventListener('click', accept)
    el.querySelector('.cookie-reject').addEventListener('click', reject)
    document.body.appendChild(el)
  }

  function showBanner() {
    const el = document.getElementById('cookie-banner')
    if (el) el.style.display = 'flex'
  }
  function hideBanner() {
    const el = document.getElementById('cookie-banner')
    if (el) el.style.display = 'none'
  }

  // ── Public API ───────────────────────────────────────────

  window.LazyShiftConsent = {
    open: showBanner,
    hasAnalyticsConsent: () => readChoice() === 'accepted',
    // Sends a GA4 event only when the visitor has accepted analytics.
    trackEvent(name, params) {
      if (readChoice() !== 'accepted' || !gaLoaded) return
      window.gtag('event', name, params || {})
    },
  }
  window.openCookieSettings = showBanner

  if (readChoice() === 'accepted') loadGA()

  function init() {
    buildBanner()
    if (!readChoice()) showBanner()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
