/* Cookie consent for AdSense and Analytics.
   Uses Google Consent Mode v2, which is required for serving personalised ads
   to users in the EEA, UK and Switzerland. Defaults to denied until the visitor
   chooses, then updates the existing gtag instance in place. */
(function () {
  'use strict';
  var KEY = 'atn_consent_v1';

  // Consent Mode must be set before gtag config runs, so this file loads early.
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }

  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}

  if (saved === 'granted') {
    gtag('consent', 'default', {
      ad_storage: 'granted', ad_user_data: 'granted',
      ad_personalization: 'granted', analytics_storage: 'granted'
    });
    return;
  }
  if (saved === 'denied') {
    gtag('consent', 'default', {
      ad_storage: 'denied', ad_user_data: 'denied',
      ad_personalization: 'denied', analytics_storage: 'denied'
    });
    return;
  }

  gtag('consent', 'default', {
    ad_storage: 'denied', ad_user_data: 'denied',
    ad_personalization: 'denied', analytics_storage: 'denied',
    wait_for_update: 500
  });

  function apply(state) {
    try { localStorage.setItem(KEY, state); } catch (e) {}
    gtag('consent', 'update', {
      ad_storage: state, ad_user_data: state,
      ad_personalization: state, analytics_storage: state
    });
  }

  function render() {
    if (document.getElementById('atn-consent')) return;
    var bar = document.createElement('div');
    bar.id = 'atn-consent';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Cookie consent');
    bar.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#0F172A;color:#F8FAFC;' +
      'padding:16px 20px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:center;' +
      'font-size:.9rem;line-height:1.5;box-shadow:0 -2px 16px rgba(0,0,0,.25)';
    bar.innerHTML =
      '<span style="flex:1 1 320px;max-width:720px">We use cookies to run analytics and to show adverts that keep this site free. ' +
      'You can accept, or continue with non-personalised adverts. ' +
      '<a href="/privacy-policy" style="color:#818CF8;text-decoration:underline">Privacy Policy</a></span>' +
      '<span style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button type="button" id="atn-reject" style="padding:9px 16px;border-radius:8px;border:1px solid #475569;' +
      'background:transparent;color:#F8FAFC;cursor:pointer;font-size:.9rem">Reject</button>' +
      '<button type="button" id="atn-accept" style="padding:9px 18px;border-radius:8px;border:0;' +
      'background:#6366F1;color:#fff;cursor:pointer;font-weight:600;font-size:.9rem">Accept</button>' +
      '</span>';
    document.body.appendChild(bar);

    document.getElementById('atn-accept').onclick = function () { apply('granted'); bar.remove(); };
    document.getElementById('atn-reject').onclick = function () { apply('denied'); bar.remove(); };
  }

  // Allow Privacy page "Manage cookies" buttons to re-open the banner.
  window.atnOpenCookieSettings = function () {
    try { localStorage.removeItem(KEY); } catch (e) {}
    var old = document.getElementById('atn-consent');
    if (old) old.remove();
    gtag('consent', 'default', {
      ad_storage: 'denied', ad_user_data: 'denied',
      ad_personalization: 'denied', analytics_storage: 'denied',
      wait_for_update: 500
    });
    render();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
