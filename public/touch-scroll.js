// Touch scrolling with inertia for xterm.js v6 (which doesn't support native touch scroll).
// Shared by the full terminal (client.ts) and inline mini-terminals (mini-terminal.ts).
const SWIPE_GAIN = 1.8;
const FRICTION = 0.975;
const STOP_THRESHOLD = 0.03; // px/ms
const BOUNCE_RESISTANCE = 0.35;
const BOUNCE_BACK_SPEED = 0.15;
export function bindTouchScroll(opts) {
    const { el, scrollLines, isAtTop, isAtBottom, bounceEl } = opts;
    const lineH = opts.lineHeight;
    const bounce = bounceEl != null;
    let touchY = null;
    let accum = 0;
    let velocity = 0;
    let lastTime = 0;
    let inertiaId = 0;
    let overscroll = 0;
    function applyOverscroll() {
        if (!bounceEl)
            return;
        bounceEl.style.transform = Math.abs(overscroll) < 0.5 ? '' : `translateY(${-overscroll}px)`;
    }
    function stopInertia() {
        if (inertiaId) {
            cancelAnimationFrame(inertiaId);
            inertiaId = 0;
        }
        velocity = 0;
    }
    function bounceBack() {
        if (Math.abs(overscroll) < 0.5) {
            overscroll = 0;
            applyOverscroll();
            inertiaId = 0;
            return;
        }
        overscroll *= (1 - BOUNCE_BACK_SPEED);
        applyOverscroll();
        inertiaId = requestAnimationFrame(bounceBack);
    }
    function inertiaLoop() {
        velocity *= FRICTION;
        if (Math.abs(velocity) < STOP_THRESHOLD) {
            if (bounce && Math.abs(overscroll) > 0.5) {
                inertiaId = requestAnimationFrame(bounceBack);
            }
            else {
                overscroll = 0;
                applyOverscroll();
                inertiaId = 0;
            }
            return;
        }
        const down = velocity > 0;
        const up = velocity < 0;
        if ((down && isAtBottom()) || (up && isAtTop())) {
            if (bounce) {
                overscroll += velocity * 16 * BOUNCE_RESISTANCE;
                overscroll = Math.max(-60, Math.min(60, overscroll));
                applyOverscroll();
                velocity *= 0.9;
            }
            else {
                inertiaId = 0;
                return;
            }
        }
        else {
            accum += velocity * 16;
            const lines = Math.trunc(accum / lineH);
            if (lines !== 0) {
                scrollLines(lines);
                accum -= lines * lineH;
            }
        }
        inertiaId = requestAnimationFrame(inertiaLoop);
    }
    el.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            stopInertia();
            if (bounce && Math.abs(overscroll) > 0.5) {
                overscroll = 0;
                applyOverscroll();
            }
            touchY = e.touches[0].clientY;
            lastTime = e.timeStamp;
            accum = 0;
        }
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
        if (touchY === null || e.touches.length !== 1)
            return;
        const y = e.touches[0].clientY;
        const dt = Math.max(1, e.timeStamp - lastTime);
        const dy = (touchY - y) * SWIPE_GAIN;
        const instantV = dy / dt;
        velocity = velocity * 0.3 + instantV * 0.7;
        lastTime = e.timeStamp;
        touchY = y;
        const down = dy > 0;
        const up = dy < 0;
        if ((down && isAtBottom()) || (up && isAtTop())) {
            if (bounce) {
                overscroll += dy * BOUNCE_RESISTANCE;
                overscroll = Math.max(-80, Math.min(80, overscroll));
                applyOverscroll();
            }
            return; // let page scroll through at edges (non-bounce) or show overscroll (bounce)
        }
        accum += dy;
        const lines = Math.trunc(accum / lineH);
        if (lines !== 0) {
            scrollLines(lines);
            accum -= lines * lineH;
        }
        e.preventDefault();
    }, { passive: false });
    const endTouch = () => {
        touchY = null;
        if (bounce && Math.abs(overscroll) > 0.5) {
            velocity = 0;
            inertiaId = requestAnimationFrame(bounceBack);
        }
        else if (Math.abs(velocity) > STOP_THRESHOLD) {
            inertiaId = requestAnimationFrame(inertiaLoop);
        }
    };
    el.addEventListener('touchend', endTouch, { passive: true });
    el.addEventListener('touchcancel', endTouch, { passive: true });
    return {
        stop() {
            stopInertia();
            overscroll = 0;
            applyOverscroll();
        },
    };
}
