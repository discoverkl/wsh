// Mobile swipe-to-reveal for app cards.
// Cards are always wrapped; swipe gestures only activate in narrow+touch mode.
// Usage: SwipeCards.init() after cards are rendered (safe to call multiple times).
const SWIPE_THRESHOLD = 144; // 2 action buttons × 72px
let activeSwipe = null;
let bound = false;
function isSwipeEnabled() {
    const d = document.documentElement;
    return d.classList.contains('narrow') && d.classList.contains('touch');
}
function closeSwipe() {
    if (activeSwipe) {
        const card = activeSwipe.querySelector('.card');
        if (card)
            card.style.transform = '';
        activeSwipe = null;
    }
}
function wrapCard(a, app, escapeAttr) {
    const wrap = document.createElement('div');
    wrap.className = 'card-swipe-wrap';
    if (a.dataset.hidden === '1') {
        wrap.style.display = 'none';
        wrap.dataset.hidden = '1';
    }
    wrap.dataset.title = a.dataset.title;
    wrap.dataset.desc = a.dataset.desc;
    const infoSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    const hideSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>' +
        '<path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>' +
        '<line x1="1" y1="1" x2="23" y2="23"/></svg>';
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.innerHTML =
        '<button class="card-action-btn action-info" data-action="info" data-app="' + escapeAttr(app.key) + '">' + infoSvg + '<span>Info</span></button>' +
            '<button class="card-action-btn action-hide" data-action="hide" data-app="' + escapeAttr(app.key) + '">' + hideSvg + '<span>Hide</span></button>';
    wrap.appendChild(actions);
    wrap.appendChild(a);
    return wrap;
}
function bindTouchEvents() {
    if (bound)
        return;
    bound = true;
    document.addEventListener('touchstart', (e) => {
        if (!isSwipeEnabled())
            return;
        const wrap = e.target.closest('.card-swipe-wrap');
        if (!wrap) {
            closeSwipe();
            return;
        }
        const card = wrap.querySelector('.card');
        if (!card)
            return;
        const touch = e.touches[0];
        wrap._swipe = { startX: touch.clientX, startY: touch.clientY, moved: false };
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
        if (!isSwipeEnabled())
            return;
        const wrap = e.target.closest('.card-swipe-wrap');
        if (!wrap || !wrap._swipe)
            return;
        const touch = e.touches[0];
        const dx = touch.clientX - wrap._swipe.startX;
        const dy = touch.clientY - wrap._swipe.startY;
        // If vertical scroll is dominant, cancel swipe
        if (!wrap._swipe.moved && Math.abs(dy) > Math.abs(dx)) {
            wrap._swipe = null;
            return;
        }
        wrap._swipe.moved = true;
        const card = wrap.querySelector('.card');
        const offset = Math.min(0, Math.max(-SWIPE_THRESHOLD, dx));
        card.style.transition = 'none';
        card.style.transform = 'translateX(' + offset + 'px)';
        if (Math.abs(dx) > 10)
            e.preventDefault();
    }, { passive: false });
    document.addEventListener('touchend', (e) => {
        if (!isSwipeEnabled())
            return;
        const wrap = e.target.closest('.card-swipe-wrap');
        if (!wrap || !wrap._swipe)
            return;
        const touch = e.changedTouches[0];
        const dx = touch.clientX - wrap._swipe.startX;
        const card = wrap.querySelector('.card');
        card.style.transition = 'transform 0.25s ease';
        if (dx < -60) {
            if (activeSwipe && activeSwipe !== wrap)
                closeSwipe();
            card.style.transform = 'translateX(-' + SWIPE_THRESHOLD + 'px)';
            activeSwipe = wrap;
        }
        else {
            card.style.transform = '';
            if (activeSwipe === wrap)
                activeSwipe = null;
        }
        wrap._swipe = null;
    }, { passive: true });
    // Close any open swipe when switching away from narrow+touch (e.g. landscape rotation)
    matchMedia('(max-width:640px)').addEventListener('change', () => { closeSwipe(); });
    // Handle action button taps
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.card-action-btn');
        if (!btn)
            return;
        e.preventDefault();
        const action = btn.dataset.action;
        if (action === 'info') {
            const wrap = btn.closest('.card-swipe-wrap');
            const existing = wrap.parentNode.querySelector('.card-info-panel[data-for="' + wrap.dataset.title + '"]');
            if (existing) {
                existing.remove();
                closeSwipe();
                return;
            }
            const cardEl = wrap.querySelector('.card');
            const popover = cardEl.querySelector('.config-popover');
            const panel = document.createElement('div');
            panel.className = 'card-info-panel';
            panel.dataset.for = wrap.dataset.title;
            panel.style.cssText =
                'background:var(--bg-card-hover);border:1px solid var(--border-hover);border-radius:10px;' +
                    'padding:14px 16px;margin-top:-8px;margin-bottom:12px;font-size:13px;' +
                    'color:var(--text-secondary);line-height:1.5;';
            const desc = wrap.dataset.desc || '';
            const descHtml = desc ? '<div style="margin-bottom:10px">' + desc + '</div>' : '';
            panel.innerHTML = descHtml + (popover ? popover.innerHTML : '');
            wrap.parentNode.insertBefore(panel, wrap.nextSibling);
            closeSwipe();
        }
        else if (action === 'hide') {
            const appKey = btn.dataset.app;
            const wrap = btn.closest('.card-swipe-wrap');
            btn.querySelector('span').textContent = '...';
            fetch('./api/apps/' + encodeURIComponent(appKey) + '/hide', { method: 'POST' })
                .then((res) => res.json())
                .then(() => {
                closeSwipe();
                wrap.style.transition = 'opacity 0.3s, transform 0.3s';
                wrap.style.opacity = '0';
                wrap.style.transform = 'scale(0.95)';
                setTimeout(() => { wrap.style.display = 'none'; }, 300);
            })
                .catch(() => { btn.querySelector('span').textContent = 'Hide'; });
        }
    });
}
export { wrapCard, bindTouchEvents as init, closeSwipe as close };
