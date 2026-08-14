import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * What a push displaced, kept so an overwrite is recoverable.
 *
 * The guard in syncState.ts is what stops a push from destroying work nobody
 * copied back; this is what undoes it when someone says yes anyway. Designed in
 * abox's sync.md → Trash.
 *
 * **Nothing is copied.** The trash sits on the same filesystem as the tree it
 * shadows — both under $HOME — and apply already stages then promotes by
 * rename, so displacing the old file is one extra rename() rather than a read
 * and a write. The only cost is that the old bytes stay allocated. That is what
 * makes it affordable on a whole-box push: it holds the *overwritten set*, never
 * the tree, and a mirror onto a fresh box trashes nothing at all.
 *
 * Denied in push-ignore.d for the same reason the sync records are: a mirror
 * must not inherit the source box's undo. Because deny rules are two-way
 * invisible, a whole-box push can neither carry one in nor delete it as a
 * leftover.
 */

const TRASH_HOME = os.homedir();

export const PUSH_TRASH_DIR = path.join(TRASH_HOME, '.wsh', 'trash');

/**
 * How long a displaced file is kept, and how much of the disk it may hold.
 *
 * Two bounds because either alone fails on a real box: an age window lets one
 * afternoon of mirrors fill the disk, and a size cap alone keeps a single stale
 * batch forever on a box nobody pushes to. The size cap is itself the smaller
 * of an absolute ceiling and a share of what is actually free, so a small box
 * is not handed a 5 GB bill it cannot pay.
 */
const PUSH_TRASH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PUSH_TRASH_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const PUSH_TRASH_FREE_SHARE = 0.1;

/**
 * One batch per apply, named so the directory sorts by time.
 *
 * A batch rather than a flat mirror because the question people ask is "what
 * did that push take", not "what happened to this one file" — and because two
 * pushes that overwrite the same path must not have the second one's copy
 * replace the first one's, which is the one thing a flat mirror cannot avoid.
 */
export function pushTrashStamp(): string {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${now}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * The file each batch records its own size in.
 *
 * Written once, when the apply that filled the batch finishes. The alternative
 * — measuring at sweep time — means recursively stat-ing every batch under
 * consideration before deciding anything, serially, before the manifest has
 * even been read. On a large trash that is tens of thousands of syscalls in
 * front of every push, to answer a question the process that created the batch
 * already knew the answer to.
 */
const PUSH_TRASH_SIZE_FILE = '.bytes';

/** Record what a batch holds, so the sweep never has to go and measure. */
export async function pushTrashRecordSize(stamp: string, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  try {
    await fs.promises.writeFile(path.join(PUSH_TRASH_DIR, stamp, PUSH_TRASH_SIZE_FILE), String(bytes), 'utf8');
  } catch { /* a batch with no sidecar is simply sized 0 by the sweep */ }
}

/** What a batch says it holds. 0 when it never got to say — see the sweep. */
async function pushTrashRecordedBytes(abs: string): Promise<number> {
  try {
    const n = Number(await fs.promises.readFile(path.join(abs, PUSH_TRASH_SIZE_FILE), 'utf8'));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Move what is at `abs` into this apply's trash batch, preserving its
 * $HOME-relative shape so a person can find it again.
 *
 * Returns the bytes displaced, or 0 when there was nothing there — which is the
 * common case, since most of what a push writes is new.
 *
 * Best-effort in one specific direction: if the rename fails the caller carries
 * on and the file is overwritten as it always was. Failing the push instead
 * would mean a box that cannot accept a sync because it could not arrange to
 * undo one, which trades a recoverable outcome for an unusable one.
 */
export async function pushTrashDisplace(stamp: string, homeRel: string, abs: string): Promise<{ moved: boolean; bytes: number }> {
  let bytes: number;
  try {
    const st = await fs.promises.lstat(abs);
    // A directory's own size, not its contents'. Recursively measuring one just
    // to put a number in a summary line meant a displaced node_modules cost a
    // full walk before the single rename that does the actual work.
    bytes = st.size;
  } catch {
    // Nothing there to displace — the overwhelmingly common case, and the
    // reason a mirror onto a fresh box costs nothing at all.
    return { moved: false, bytes: 0 };
  }
  const dst = path.join(PUSH_TRASH_DIR, stamp, homeRel);
  try {
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.rename(abs, dst);
    return { moved: true, bytes };
  } catch (err) {
    console.error(`[trash] could not displace ${homeRel}: ${err instanceof Error ? err.message : String(err)}`);
    return { moved: false, bytes: 0 };
  }
}

/**
 * Batches, newest first. One stat each, and a size only for the ones that
 * survive the age cut — nothing is measured that is about to be removed.
 */
async function pushTrashBatches(cutoff: number): Promise<{ abs: string; at: number; bytes: number; tooOld: boolean }[]> {
  let ents: fs.Dirent[];
  try { ents = await fs.promises.readdir(PUSH_TRASH_DIR, { withFileTypes: true }); }
  catch { return []; }
  const out: { abs: string; at: number; bytes: number; tooOld: boolean }[] = [];
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    const abs = path.join(PUSH_TRASH_DIR, ent.name);
    let at = 0;
    try { at = (await fs.promises.stat(abs)).mtimeMs; } catch { continue; }
    const tooOld = at < cutoff;
    out.push({ abs, at, tooOld, bytes: tooOld ? 0 : await pushTrashRecordedBytes(abs) });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Bytes free on the filesystem holding the trash, or Infinity if unknowable. */
async function pushTrashFreeBytes(): Promise<number> {
  const statfs = (fs.promises as unknown as { statfs?: (p: string) => Promise<{ bsize: number; bavail: number }> }).statfs;
  if (!statfs) return Infinity;
  try {
    const st = await statfs(TRASH_HOME);
    return st.bsize * st.bavail;
  } catch {
    return Infinity;
  }
}

/**
 * Drop batches past the age window, then the oldest until the rest fit the size
 * cap. Returns the bytes reclaimed.
 *
 * Swept *before* an apply rather than after, so a second mirror does not stack
 * on the first one's trash — which is exactly the sequence that would otherwise
 * run a box out of disk, since the second mirror is also the one displacing the
 * most. No timer and no daemon: the only thing that fills the trash is a push,
 * so a push is the only thing that needs to empty it.
 */
export async function pushTrashSweep(): Promise<number> {
  const cutoff = Date.now() - PUSH_TRASH_MAX_AGE_MS;
  const batches = await pushTrashBatches(cutoff);
  if (batches.length === 0) return 0;

  const free = await pushTrashFreeBytes();
  const cap = Math.min(PUSH_TRASH_MAX_BYTES, free === Infinity ? PUSH_TRASH_MAX_BYTES : free * PUSH_TRASH_FREE_SHARE);

  let kept = 0;
  let reclaimed = 0;
  for (const b of batches) { // newest first
    // Age first, then size: a batch inside the window can still be dropped for
    // being past the cap, but one outside it goes regardless of how small the
    // total is. Otherwise a box nobody pushes to keeps one batch for ever.
    const tooBig = kept + b.bytes > cap;
    if (!b.tooOld && !tooBig) { kept += b.bytes; continue; }
    try {
      await fs.promises.rm(b.abs, { recursive: true, force: true });
      reclaimed += b.bytes;
    } catch (err) {
      console.error(`[trash] sweep failed for ${b.abs}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return reclaimed;
}
