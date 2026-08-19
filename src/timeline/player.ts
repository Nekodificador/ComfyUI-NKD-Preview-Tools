/**
 * NKD Timeline - transport.
 *
 * The playhead runs off `performance.now()`, and the audio is SCHEDULED AHEAD on the
 * AudioContext clock rather than nudged frame by frame - nudging drifts audibly within
 * seconds. Picture and sound therefore share no clock; they agree because both are placed
 * from the same frame positions.
 *
 * The timeline is deliberately not tied to a `<video>`'s `currentTime`: several clips can
 * sit under the playhead at once and a gap has no element at all, so any such binding
 * breaks the moment the playhead crosses a cut. The picture follows instead - the editor
 * asks the pooled element for whatever clip is currently under the playhead.
 */
import { type Timeline, gainAt } from "./model";
import { audioBufferFor, audioContext, ensureAudio, type MediaRef } from "./media";

/** J and L step through these. Index 0 is the resting speed for each direction. */
const SHUTTLE = [1, 2, 4, 8];

/** The transport currently running, if any. See `play`. */
let playing: Transport | null = null;

type Faded = { length: number; gain?: number; fadeIn?: number; fadeOut?: number;
               muted?: boolean };

/**
 * Automate one clip's level on the AudioContext clock.
 *
 * The whole clip is scheduled in one shot, so the ramps have to be placed as events rather
 * than nudged per frame - and they are anchored to the SEGMENT we are about to play, which
 * may start partway into the clip because that is where the playhead was. Starting at the
 * clip's nominal level in that case would replay the fade-in from the middle of it, which
 * is audible as a swell every time you hit Space inside a fade.
 *
 * `gainAt` is shared with the model (and mirrored in Python), so the preview, the drawn
 * ramp and the rendered file all describe the same curve.
 */
function applyFades(param: AudioParam, c: Faded, startOff: number, endOff: number,
                    when: number, fps: number): void {
  const base = c.gain ?? 1;
  const at = (off: number) => when + (off - startOff) / fps;
  param.setValueAtTime(gainAt(c, startOff), when);

  const fi = c.fadeIn ?? 0;
  if (fi > startOff && fi < endOff) param.linearRampToValueAtTime(base, at(fi));

  const fo = c.fadeOut ?? 0;
  const foStart = c.length - fo;
  if (fo > 0 && foStart < endOff) {
    // Hold the level flat until the ramp is due; without this anchor the Web Audio API
    // interpolates from the PREVIOUS event, so the fade-out would start at the head of
    // the clip and the whole thing would sag.
    if (foStart > startOff) param.setValueAtTime(base, at(foStart));
    param.linearRampToValueAtTime(gainAt(c, endOff - 1e-6), at(endOff));
  }
}

export interface PlayerHost {
  getTimeline(): Timeline;
  getFps(): number;
  getStartFrame(): number;
  getEndFrame(): number;
  /** Move the playhead. The editor owns clamping and repainting. */
  seek(frame: number): void;
  /** Clips resolve to a decoded buffer through here; null when unresolved. */
  audioRefFor(src: string): MediaRef | null;
  /** Native rate of a source. A video's trimIn is in SOURCE frames, so its audio offset
   *  needs that rate; a tensor or audio clip runs at the timeline rate. */
  srcFpsFor(src: string): number;
}

export class Transport {
  private readonly host: PlayerHost;
  private raf = 0;
  private last = 0;
  /** Signed: negative is reverse. 0 means stopped. */
  private speed = 0;
  /**
   * Sub-frame playhead position, kept HERE as a float.
   *
   * It must never be re-read from `ui.playhead`, which is rounded for display: at 24 fps
   * on a 60 Hz frame loop each tick advances ~0.4 frames, `Math.round` throws that away,
   * and the next tick starts from the same integer again - the playhead sticks while the
   * <video> plays on, until the drift correction yanks the picture backwards. That is the
   * classic accumulate-into-a-rounded-value bug, and it looks exactly like a stutter.
   */
  private pos = 0;
  private nodes: AudioBufferSourceNode[] = [];
  private gain: GainNode | null = null;
  onChange: (() => void) | null = null;

  constructor(host: PlayerHost) {
    this.host = host;
  }

  get rate(): number { return this.speed; }

  /** Space / the play button: toggle between stopped and 1x forward. */
  toggle(): void {
    if (this.speed === 0) this.play(1);
    else this.stop();
  }

  /** L steps forward through the shuttle speeds, J steps backward. Pressing the opposite
   *  direction first brings it back to a stop, the way every NLE behaves. */
  shuttle(dir: 1 | -1): void {
    const cur = this.speed;
    if (cur === 0 || Math.sign(cur) !== dir) {
      this.play(dir);
      return;
    }
    const i = SHUTTLE.indexOf(Math.abs(cur));
    this.play(dir * SHUTTLE[Math.min(SHUTTLE.length - 1, i + 1)]);
  }

  play(speed: number): void {
    // Only one transport at a time, across every Timeline node on the canvas. Genuinely
    // global, unlike everything else that used to be: there is one pair of speakers, and
    // two timelines running mix both soundtracks into the same destination.
    if (playing && playing !== this) playing.stop();
    playing = this;
    this.speed = speed;
    this.pos = this.host.getTimeline().ui.playhead;
    this.last = performance.now();
    this.scheduleAudio();
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
    this.onChange?.();
  }

  stop(): void {
    if (playing === this) playing = null;
    this.speed = 0;
    this.stopAudio();
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.onChange?.();
  }

  private tick = (now: number): void => {
    if (this.speed === 0) { this.raf = 0; return; }
    const dt = Math.min(0.25, (now - this.last) / 1000);  // a stalled tab must not jump
    this.last = now;
    const fps = this.host.getFps();
    const start = this.host.getStartFrame();
    const end = this.host.getEndFrame();
    this.pos += dt * fps * this.speed;

    if (this.pos >= end - 1) {      // loop the in/out range, like a preview should
      this.pos = start;
      this.restartAudio();
    } else if (this.pos < start) {
      this.pos = end - 1;
      this.restartAudio();
    }
    this.host.seek(Math.round(this.pos));
    this.raf = requestAnimationFrame(this.tick);
  };

  // ── Audio ───────────────────────────────────────────────────────────────────

  private stopAudio(): void {
    for (const n of this.nodes) {
      try { n.stop(); } catch { /* already finished */ }
    }
    this.nodes = [];
    // Every schedule builds a fresh master gain; the old one stayed wired to the
    // speakers forever (a leak per play press, per loop wrap and per fade tweak).
    this.gain?.disconnect();
    this.gain = null;
  }

  /** Re-schedule from the current position: a mute toggled mid-playback. */
  refreshAudio(): void {
    if (this.speed === 1) this.restartAudio();
  }

  private restartAudio(): void {
    this.stopAudio();
    this.scheduleAudio();
  }

  /**
   * Schedule every audio clip that is still ahead of the playhead, each at its own offset
   * on the AudioContext clock. Scheduling up front is what keeps it in sync: nudging
   * playback from a rAF loop would drift audibly within seconds.
   *
   * Reverse and shuttle speeds run silent - browsers cannot play a buffer backwards, and
   * pitch-shifted scrub audio is noise rather than information.
   */
  private scheduleAudio(): void {
    this.stopAudio();
    if (this.speed !== 1) return;
    const ctx = audioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const tl = this.host.getTimeline();
    const fps = this.host.getFps();
    const end = this.host.getEndFrame();
    // The transport's OWN position, never `ui.playhead`: on a loop wrap the tick resets
    // `pos` and reschedules BEFORE the seek writes the new playhead back, so reading the
    // widget here scheduled the whole pass from the old end-of-range position - zero
    // nodes, a silent pass, and pressing play twice "fixed" it. (Reported by Neko.)
    const now = Math.round(this.pos);

    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);

    // Both lanes: the audio track AND the videos' own sound, which is what the backend
    // mixes too. Without the second one, playing a clip with dialogue is silent.
    const lanes: { src: string; start: number; trimIn: number; length: number;
                   gain?: number; fadeIn?: number; fadeOut?: number;
                   muted?: boolean; sourceRate: boolean }[] = [
      ...tl.audio.map((a) => ({ ...a, sourceRate: false })),
      ...tl.clips.map((c) => ({ ...c, sourceRate: true })),
    ];

    for (const a of lanes) {
      if (a.muted) continue;
      const ref = this.host.audioRefFor(a.src);
      if (!ref) continue;
      const buf = audioBufferFor(ref);
      if (!buf) {
        // Not decoded yet: ask for it and re-schedule once it lands, so the very first
        // play is not silent. ensureAudio is cached and deduped, so this cannot loop.
        ensureAudio(ref, () => { if (this.speed === 1) this.restartAudio(); });
        continue;
      }
      const clipEnd = Math.min(a.start + a.length, end);
      if (clipEnd <= now) continue;                    // already behind the playhead
      const from = Math.max(a.start, now);
      const when = ctx.currentTime + (from - now) / fps;
      // A video's trimIn counts SOURCE frames; an audio clip's counts timeline frames.
      const rate = a.sourceRate ? this.host.srcFpsFor(a.src) || fps : fps;
      const offset = a.trimIn / rate + (from - a.start) / fps;
      const duration = (clipEnd - from) / fps;
      if (duration <= 0 || offset >= buf.duration) continue;

      const node = ctx.createBufferSource();
      node.buffer = buf;
      const g = ctx.createGain();
      applyFades(g.gain, a, from - a.start, clipEnd - a.start, when, fps);
      node.connect(g);
      g.connect(this.gain);
      node.start(when, offset, Math.min(duration, buf.duration - offset));
      this.nodes.push(node);
    }
  }

  /** The user grabbed the playhead while it was running: adopt their position instead of
   *  fighting them back to ours. */
  reanchor(frame: number): void {
    this.pos = frame;
  }

  destroy(): void {
    this.stop();
    this.gain?.disconnect();
    this.gain = null;
  }
}

