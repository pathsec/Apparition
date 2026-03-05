'use strict';
// Highlight the active nav link
(function () {
  const links = document.querySelectorAll('.nav-links a');
  const path  = window.location.pathname;
  links.forEach(a => {
    if (path.startsWith(a.getAttribute('href'))) {
      a.style.background = 'var(--border)';
      a.style.color      = 'var(--text)';
    }
  });
})();
