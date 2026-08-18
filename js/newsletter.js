/* Newsletter signup.
   The backend at /api/subscribe already existed and works, but nothing on the
   site ever called it, so the list stayed empty. This renders a real form and
   posts to it. */
(function () {
  'use strict';

  function markup() {
    return '' +
      '<div style="max-width:560px;margin:0 auto;text-align:center">' +
        '<h2 style="font-size:1.5rem;margin:0 0 8px">Get the best free AI tools in your inbox</h2>' +
        '<p style="color:#64748B;margin:0 0 18px;font-size:.95rem">' +
          'One short email a week: new tools we have tested, and the guides worth your time. No spam, unsubscribe anytime.' +
        '</p>' +
        '<form class="atn-sub-form" novalidate style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">' +
          '<label for="atn-sub-email" style="position:absolute;left:-9999px">Email address</label>' +
          '<input id="atn-sub-email" type="email" name="email" required autocomplete="email" ' +
            'placeholder="you@example.com" ' +
            'style="flex:1 1 260px;min-width:0;padding:12px 14px;border:1px solid #E2E8F0;border-radius:10px;font-size:1rem;font-family:inherit">' +
          '<button type="submit" ' +
            'style="padding:12px 24px;border:0;border-radius:10px;background:#6366F1;color:#fff;font-weight:700;font-size:1rem;cursor:pointer;font-family:inherit">' +
            'Subscribe</button>' +
        '</form>' +
        '<p class="atn-sub-msg" role="status" aria-live="polite" style="margin:12px 0 0;font-size:.9rem;min-height:1.2em"></p>' +
      '</div>';
  }

  function wire(root) {
    var form = root.querySelector('.atn-sub-form');
    var msg = root.querySelector('.atn-sub-msg');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = form.querySelector('input[type=email]');
      var btn = form.querySelector('button');
      var email = (input.value || '').trim();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msg.style.color = '#DC2626';
        msg.textContent = 'Please enter a valid email address.';
        input.focus();
        return;
      }

      btn.disabled = true;
      var label = btn.textContent;
      btn.textContent = 'Subscribing...';
      msg.style.color = '#64748B';
      msg.textContent = '';

      fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, source: location.pathname })
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (d) {
          if (d && d.ok) {
            msg.style.color = '#16A34A';
            msg.textContent = 'Thanks — you are subscribed.';
            form.reset();
          } else {
            msg.style.color = '#DC2626';
            msg.textContent = (d && d.detail) ? d.detail : 'Something went wrong. Please try again.';
          }
        })
        .catch(function () {
          msg.style.color = '#DC2626';
          msg.textContent = 'Network error. Please try again.';
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = label;
        });
    });
  }

  function init() {
    var hosts = document.querySelectorAll('[data-atn-newsletter]');
    for (var i = 0; i < hosts.length; i++) {
      if (hosts[i].getAttribute('data-atn-ready')) continue;
      hosts[i].setAttribute('data-atn-ready', '1');
      hosts[i].innerHTML = markup();
      wire(hosts[i]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
