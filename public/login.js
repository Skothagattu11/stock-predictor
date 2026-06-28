(() => {
  'use strict';

  // Redirect if already logged in
  if (localStorage.getItem('wm_token')) {
    window.location.href = '/manager.html';
  }

  function showErr(msg) {
    const el = document.getElementById('errBox');
    el.textContent = msg;
    el.style.display = 'block';
  }

  document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    document.getElementById('errBox').style.display = 'none';
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const btn = document.getElementById('submitBtn');
    btn.disabled = true;
    btn.textContent = '…';

    try {
      const res = await fetch('/api/manager/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { showErr(data.error || 'Invalid email or password'); return; }
      localStorage.setItem('wm_token', data.access_token);
      localStorage.setItem('wm_user', JSON.stringify(data.user));
      const next = new URLSearchParams(window.location.search).get('next') || '/manager.html';
      window.location.href = next;
    } catch {
      showErr('Network error — please try again');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });
})();
