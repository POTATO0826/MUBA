#!/usr/bin/env bash
#
# Regenerate `case-tick.mp3` and `case-land.mp3` from the owner's recording.
#
#   bash src/assets/slice-case-open.sh [path/to/csgo-case-open.mp3]
#
# The source is a single real CS:GO case-open take: 12.888s, 48kHz stereo. It is
# operator-supplied and gitignored (`*.mp3`), so this script — not the mp3s — is
# what lives in the repo. Run it from the repo root with the recording present
# and the two slices reappear byte-for-byte.
#
# Requires ffmpeg/ffprobe on PATH (developed against 8.1.2).

set -euo pipefail

SRC="${1:-csgo-case-open.mp3}"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -f "$SRC" ] || { echo "no source recording at $SRC" >&2; exit 1; }

# ── Where the cuts come from ──────────────────────────────────────────────
#
# The take was analysed by decoding it to mono f32 and walking a 5ms peak
# envelope, then zooming to 0.5ms around each candidate. Its shape is:
#
#   0.00-0.13  digital silence
#   0.14-1.05  pre-roll UI noise
#   ~1.35      the case-opens hit (peak 0.649)
#   1.59-1.72  the first, slow ticks
#   1.78-6.28  the main tick run
#   6.65-6.82  a tick cluster after a 400ms gap
#   6.94-6.97  ONE ISOLATED TICK                      <- case-tick.mp3
#   7.62-7.86  the final decelerating ticks
#   7.87-7.89  silence
#   7.89-~12.2 the reveal sting, decaying out          <- case-land.mp3
#
# The obvious choice — a tick from the middle of the run — does not exist:
# from 1.78 to 6.28 the ticks never return to the noise floor between hits,
# because each one is still ringing when the next lands. The higher peaks
# there (0.35-0.40 against this one's 0.15) are two ticks summing, not a
# louder tick, so the isolated hit at 6.94 is the truest single-tick timbre
# in the file, not a weaker one. Normalisation puts the level back.

# ── The tick ──────────────────────────────────────────────────────────────
#
# 6.935 -> 7.010. That is 7.5ms of floor before the attack at 6.9425 and 67ms
# after it; the hit has decayed back into the floor by 6.970 and nothing else
# happens for another 600ms, so the window holds one tick and its whole tail.
#
# Mono: the tick is centred, and the engine pans it per-voice if a caller asks.
# 1.5ms in-fade so the cut cannot click; 12ms out-fade landing exactly on the
# end of the file, which matters more than usual here — this sample can fire
# ~18x a second under the R3 rate limit, and a clicking tail would stack into
# a buzz.
TICK_SS=6.935
TICK_T=0.075
TICK_AF="afade=t=in:st=0:d=0.0015,afade=t=out:st=0.063:d=0.012"

# ── The sting ─────────────────────────────────────────────────────────────
#
# 7.885 -> 9.185. Starts inside the 20ms of true silence that separates the
# last tick from the reveal, so the attack is intact and unheralded.
#
# The sting's natural tail runs to ~12.2s, which is far too long for a sound
# that fires once per leg: it would still be ringing under the next leg's
# ticks. 1.30s keeps the impact, the swell (its loudest point is 0.4-0.8s IN,
# not at the transient) and the first of the decay. At 9.185 the material is
# still a plateau rather than a tail, so the out-fade is a long 250ms — that
# length, not the cut point, is what makes the truncation inaudible.
#
# Stereo is kept: the source is stereo and the sting is the one slice wide
# enough for it to read.
LAND_SS=7.885
LAND_T=1.300
LAND_AF="afade=t=in:st=0:d=0.002,afade=t=out:st=1.050:d=0.250"

# Both slices are mastered to this peak. -3dBFS leaves the master compressor
# something to work with and keeps the mp3 decoder off the rails.
TARGET_DBFS=-3.0

# ── Normalise, encode, then correct for the encoder ───────────────────────
#
# Three passes, not two. The usual two — measure the raw peak, apply the
# difference — are not enough for mp3: the decoder reconstructs a short
# transient ABOVE the peak it was handed, and the tick overshoots by ~2.8dB.
# Encoding to -3 the naive way lands at -0.2dBFS, close enough to clipping to
# matter. So the third pass measures what actually comes back out and folds
# the error into the gain.
#
# -q:a 2 is VBR ~190kbps. Well past transparent for material this short, and
# the whole point of slicing a real recording is to keep what makes it real.

peak_of() { # -> the file's max_volume in dB, as a bare number
  ffmpeg -hide_banner -i "$1" -af volumedetect -f null - 2>&1 |
    sed -n 's/.*max_volume: \(-\?[0-9.]*\) dB.*/\1/p' | tail -1
}

slice() { # name ss t af [extra ffmpeg args, e.g. -ac 1]
  local name="$1" ss="$2" t="$3" af="$4"
  shift 4
  local extra=("$@")
  local dst="$OUT/$name.mp3"

  # Pass 1 — what the raw window peaks at.
  local raw gain got
  raw=$(ffmpeg -hide_banner -ss "$ss" -t "$t" -i "$SRC" "${extra[@]}" \
    -af volumedetect -f null - 2>&1 |
    sed -n 's/.*max_volume: \(-\?[0-9.]*\) dB.*/\1/p' | tail -1)
  gain=$(awk -v t="$TARGET_DBFS" -v r="$raw" 'BEGIN { printf "%.1f", t - r }')

  # Pass 2 — encode at that gain and see where the DECODER lands.
  ffmpeg -hide_banner -v error -y -ss "$ss" -t "$t" -i "$SRC" "${extra[@]}" \
    -ar 48000 -af "$af,volume=${gain}dB" -c:a libmp3lame -q:a 2 "$dst"
  got=$(peak_of "$dst")

  # Pass 3 — take the encoder's overshoot back out and re-encode.
  gain=$(awk -v g="$gain" -v t="$TARGET_DBFS" -v p="$got" \
    'BEGIN { printf "%.1f", g + (t - p) }')
  ffmpeg -hide_banner -v error -y -ss "$ss" -t "$t" -i "$SRC" "${extra[@]}" \
    -ar 48000 -af "$af,volume=${gain}dB" -c:a libmp3lame -q:a 2 "$dst"

  printf '%-10s %ss +%ss  raw %sdB  gain %sdB  -> %sdBFS\n' \
    "$name" "$ss" "$t" "$raw" "$gain" "$(peak_of "$dst")"
}

slice case-tick "$TICK_SS" "$TICK_T" "$TICK_AF" -ac 1
slice case-land "$LAND_SS" "$LAND_T" "$LAND_AF"

# ── Verify ────────────────────────────────────────────────────────────────
#
# The slices are optional assets: a broken one is served happily and fails
# silently in the browser, so it has to be caught here. Decoding both in full
# is the check — ffmpeg exits non-zero on a truncated or corrupt stream.
for f in case-tick case-land; do
  ffmpeg -v error -i "$OUT/$f.mp3" -f null - || { echo "$f.mp3 will not decode" >&2; exit 1; }
done
echo "both slices decode clean"
