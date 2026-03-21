/**
 * Gathers a rich snapshot of a running web app's state from the browser side.
 * Used to populate TARGET_DESC when spawning the app avatar skill.
 */
function getIframe() {
    return document.getElementById('web-frame');
}
function collectPageState(sections) {
    const iframe = getIframe();
    const win = iframe?.contentWindow;
    const doc = iframe?.contentDocument;
    if (!doc || !win) {
        sections.push('=== Page State ===\niframe not accessible — page may have failed to load');
        return;
    }
    const lines = [];
    // Basic page info
    lines.push(`Page title: ${doc.title || '(none)'}`);
    lines.push(`URL: ${win.location.href}`);
    const meta = doc.querySelector('meta[name="description"]')?.getAttribute('content');
    if (meta)
        lines.push(`Meta description: ${meta}`);
    if (doc.characterSet)
        lines.push(`Charset: ${doc.characterSet}`);
    if (doc.documentElement?.lang)
        lines.push(`Language: ${doc.documentElement.lang}`);
    // DOM stats
    const counts = [
        ['DOM elements', '*'],
        ['Forms', 'form'],
        ['Input fields', 'input, textarea, select'],
        ['Buttons', 'button, [role="button"], input[type="submit"]'],
        ['Links', 'a[href]'],
        ['Images', 'img'],
        ['Canvases', 'canvas'],
        ['Nested iframes', 'iframe'],
        ['Stylesheets', 'link[rel="stylesheet"], style'],
        ['Scripts', 'script'],
    ];
    for (const [label, sel] of counts) {
        const n = doc.querySelectorAll(sel).length;
        if (n > 0 || sel === '*')
            lines.push(`${label}: ${n}`);
    }
    // Viewport / scroll
    try {
        const bw = doc.body?.scrollWidth ?? 0;
        const bh = doc.body?.scrollHeight ?? 0;
        lines.push(`Viewport: ${win.innerWidth}x${win.innerHeight}, Content: ${bw}x${bh}`);
        if (bh > win.innerHeight)
            lines.push(`Scroll position: ${win.scrollY}/${bh - win.innerHeight}`);
    }
    catch { }
    // Visible text
    const text = (doc.body?.innerText || '').substring(0, 3000).trim();
    lines.push('');
    lines.push(text ? `Visible content:\n${text}` : 'Page is blank (no visible text)');
    sections.push('=== Page State ===\n' + lines.join('\n'));
}
function collectConsole(sections) {
    const win = getIframe()?.contentWindow;
    const dbg = win?._dbg;
    if (!dbg)
        return;
    const lines = [];
    if (dbg.console?.length) {
        const recent = dbg.console.slice(-30);
        lines.push(`Console (last ${recent.length} entries):`);
        for (const e of recent)
            lines.push(`  [${e.m}] ${e.v}`);
    }
    if (dbg.errors?.length) {
        lines.push(`JS errors (${dbg.errors.length}):`);
        for (const e of dbg.errors.slice(-15))
            lines.push(`  ${e.msg}${e.src ? ' @ ' + e.src : ''}`);
    }
    if (lines.length)
        sections.push('=== Console ===\n' + lines.join('\n'));
}
function collectNetwork(sections) {
    const win = getIframe()?.contentWindow;
    if (!win)
        return;
    const entries = win.performance.getEntriesByType('resource');
    const lines = [];
    lines.push(`Total resources loaded: ${entries.length}`);
    const failed = entries.filter(e => e.responseStatus >= 400);
    const blocked = entries.filter(e => e.responseStatus === 0 && e.transferSize === 0 && e.duration > 0);
    const slow = entries.filter(e => e.duration > 2000 && e.responseStatus > 0 && e.responseStatus < 400);
    if (failed.length) {
        lines.push(`Failed (${failed.length}):`);
        for (const e of failed.slice(0, 15))
            lines.push(`  ${e.responseStatus} ${e.name}`);
    }
    if (blocked.length) {
        lines.push(`Blocked/timeout (${blocked.length}):`);
        for (const e of blocked.slice(0, 10))
            lines.push(`  ${e.name}`);
    }
    if (slow.length) {
        lines.push(`Slow >2s (${slow.length}):`);
        for (const e of slow.slice(0, 10))
            lines.push(`  ${Math.round(e.duration)}ms ${e.name}`);
    }
    // Resource type breakdown
    const byType = {};
    for (const e of entries)
        byType[e.initiatorType] = (byType[e.initiatorType] || 0) + 1;
    lines.push(`By type: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    // Navigation timing
    try {
        const nav = win.performance.getEntriesByType('navigation')[0];
        if (nav) {
            lines.push(`Page load: DNS ${Math.round(nav.domainLookupEnd - nav.domainLookupStart)}ms, Connect ${Math.round(nav.connectEnd - nav.connectStart)}ms, TTFB ${Math.round(nav.responseStart - nav.requestStart)}ms, DOM ready ${Math.round(nav.domContentLoadedEventEnd - nav.startTime)}ms, Full load ${Math.round(nav.loadEventEnd - nav.startTime)}ms`);
        }
    }
    catch { }
    if (lines.length > 1 || failed.length || blocked.length) {
        sections.push('=== Network ===\n' + lines.join('\n'));
    }
}
function collectStorage(sections) {
    const win = getIframe()?.contentWindow;
    if (!win)
        return;
    const lines = [];
    try {
        const ls = win.localStorage;
        if (ls.length) {
            const keys = [];
            for (let i = 0; i < Math.min(ls.length, 20); i++)
                keys.push(ls.key(i));
            lines.push(`localStorage (${ls.length} keys): ${keys.join(', ')}`);
        }
    }
    catch { }
    try {
        const ss = win.sessionStorage;
        if (ss.length) {
            const keys = [];
            for (let i = 0; i < Math.min(ss.length, 20); i++)
                keys.push(ss.key(i));
            lines.push(`sessionStorage (${ss.length} keys): ${keys.join(', ')}`);
        }
    }
    catch { }
    if (lines.length)
        sections.push('=== Storage ===\n' + lines.join('\n'));
}
/** Each collector is wrapped in try/catch so one failure doesn't block the rest. */
const collectors = [
    collectPageState,
    collectConsole,
    collectNetwork,
    collectStorage,
];
/** Lightweight health check — cheap to call on a timer. */
export function checkAppHealth() {
    const iframe = getIframe();
    const win = iframe?.contentWindow;
    const doc = iframe?.contentDocument;
    if (!doc || !win)
        return null;
    let jsErrors = 0;
    try {
        const dbg = win?._dbg;
        jsErrors = dbg?.errors?.length ?? 0;
    }
    catch { }
    let failedRequests = 0;
    try {
        const entries = win.performance.getEntriesByType('resource');
        failedRequests = entries.filter(e => e.responseStatus >= 400).length;
    }
    catch { }
    const isBlank = !(doc.body?.innerText || '').trim();
    let level = 'healthy';
    if (jsErrors > 0 || failedRequests > 0)
        level = 'error';
    else if (isBlank)
        level = 'blank';
    return { level, jsErrors, failedRequests, isBlank };
}
export function gatherAppSnapshot(ctx) {
    const sections = [];
    // Identity (always available, no try/catch needed)
    sections.push([
        `App: ${ctx.appName}`,
        `Session: ${ctx.sessionId}`,
        ctx.sessionCwd ? `CWD: ${ctx.sessionCwd}` : null,
        `Role: ${ctx.currentRole || 'unknown'}`,
        `App type: ${ctx.appType}`,
    ].filter(Boolean).join('\n'));
    for (const collect of collectors) {
        try {
            collect(sections);
        }
        catch { }
    }
    return sections.join('\n\n');
}
