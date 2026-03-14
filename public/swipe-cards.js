// Mobile swipe-to-reveal for app cards
// Usage: SwipeCards.init() after cards are rendered
(function() {
  var SWIPE_THRESHOLD = 144; // 2 action buttons × 72px
  var activeSwipe = null;

  function closeSwipe() {
    if (activeSwipe) {
      var card = activeSwipe.querySelector('.card');
      if (card) card.style.transform = '';
      activeSwipe = null;
    }
  }

  function wrapCard(a, app, escapeAttr) {
    var wrap = document.createElement('div');
    wrap.className = 'card-swipe-wrap';
    if (a.dataset.hidden === '1') {
      wrap.style.display = 'none';
      wrap.dataset.hidden = '1';
    }
    wrap.dataset.title = a.dataset.title;
    wrap.dataset.desc = a.dataset.desc;

    var infoSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    var hideSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

    var actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.innerHTML =
      '<button class="card-action-btn action-info" data-action="info" data-app="' + escapeAttr(app.key) + '">' + infoSvg + '<span>Info</span></button>' +
      '<button class="card-action-btn action-hide" data-action="hide" data-app="' + escapeAttr(app.key) + '">' + hideSvg + '<span>Hide</span></button>';

    wrap.appendChild(actions);
    wrap.appendChild(a);
    return wrap;
  }

  function bindTouchEvents() {
    document.addEventListener('touchstart', function(e) {
      var wrap = e.target.closest('.card-swipe-wrap');
      if (!wrap) { closeSwipe(); return; }
      var card = wrap.querySelector('.card');
      if (!card) return;
      var touch = e.touches[0];
      wrap._swipe = { startX: touch.clientX, startY: touch.clientY, moved: false };
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
      var wrap = e.target.closest('.card-swipe-wrap');
      if (!wrap || !wrap._swipe) return;
      var touch = e.touches[0];
      var dx = touch.clientX - wrap._swipe.startX;
      var dy = touch.clientY - wrap._swipe.startY;
      // If vertical scroll is dominant, cancel swipe
      if (!wrap._swipe.moved && Math.abs(dy) > Math.abs(dx)) {
        wrap._swipe = null;
        return;
      }
      wrap._swipe.moved = true;
      var card = wrap.querySelector('.card');
      var offset = Math.min(0, Math.max(-SWIPE_THRESHOLD, dx));
      card.style.transition = 'none';
      card.style.transform = 'translateX(' + offset + 'px)';
      if (Math.abs(dx) > 10) e.preventDefault();
    }, { passive: false });

    document.addEventListener('touchend', function(e) {
      var wrap = e.target.closest('.card-swipe-wrap');
      if (!wrap || !wrap._swipe) return;
      var touch = e.changedTouches[0];
      var dx = touch.clientX - wrap._swipe.startX;
      var card = wrap.querySelector('.card');
      card.style.transition = 'transform 0.25s ease';
      if (dx < -60) {
        if (activeSwipe && activeSwipe !== wrap) closeSwipe();
        card.style.transform = 'translateX(-' + SWIPE_THRESHOLD + 'px)';
        activeSwipe = wrap;
      } else {
        card.style.transform = '';
        if (activeSwipe === wrap) activeSwipe = null;
      }
      wrap._swipe = null;
    }, { passive: true });

    // Handle action button taps
    document.addEventListener('click', function(e) {
      var btn = e.target.closest('.card-action-btn');
      if (!btn) return;
      e.preventDefault();
      var action = btn.dataset.action;
      if (action === 'info') {
        var wrap = btn.closest('.card-swipe-wrap');
        var existing = wrap.parentNode.querySelector('.card-info-panel[data-for="' + wrap.dataset.title + '"]');
        if (existing) { existing.remove(); closeSwipe(); return; }
        var cardEl = wrap.querySelector('.card');
        var popover = cardEl.querySelector('.config-popover');
        var panel = document.createElement('div');
        panel.className = 'card-info-panel';
        panel.dataset.for = wrap.dataset.title;
        panel.style.cssText = 'background:var(--bg-card-hover);border:1px solid var(--border-hover);border-radius:10px;padding:14px 16px;margin-top:-8px;margin-bottom:12px;font-size:13px;color:var(--text-secondary);line-height:1.5;';
        // Add full description
        var desc = wrap.dataset.desc || '';
        var descHtml = desc ? '<div style="margin-bottom:10px">' + desc + '</div>' : '';
        // Add config rows
        var popover = cardEl.querySelector('.config-popover');
        panel.innerHTML = descHtml + (popover ? popover.innerHTML : '');
        wrap.parentNode.insertBefore(panel, wrap.nextSibling);
        closeSwipe();
      } else if (action === 'hide') {
        var appKey = btn.dataset.app;
        var wrap = btn.closest('.card-swipe-wrap');
        btn.querySelector('span').textContent = '...';
        fetch('./api/apps/' + encodeURIComponent(appKey) + '/hide', { method: 'POST' })
          .then(function(res) { return res.json(); })
          .then(function() {
            closeSwipe();
            // Animate out
            wrap.style.transition = 'opacity 0.3s, transform 0.3s';
            wrap.style.opacity = '0';
            wrap.style.transform = 'scale(0.95)';
            setTimeout(function() { wrap.style.display = 'none'; }, 300);
          })
          .catch(function() { btn.querySelector('span').textContent = 'Hide'; });
      }
    });
  }

  window.SwipeCards = {
    wrapCard: wrapCard,
    init: bindTouchEvents,
    close: closeSwipe
  };
})();
