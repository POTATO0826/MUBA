# src/assets

Optional, operator-supplied media. Nothing here is required to run or test the app.

- **`room-inspect.mp3`** — the looping track behind the ready room (a CS:GO
  case-inspect mood). Drop the file in with exactly that name and it is served
  at `/assets/room-inspect.mp3`; leave it out and the room is simply silent.
- **`exo-kill-2.mp3`** — the one-shot behind the lobby board's battle button:
  **Accept match** and **Start match** (`src/ui/LobbyCards.tsx`). It replaces
  the `card.accept` / `card.start` synth events on that button rather than
  layering over them.
- **`exo-kill-4.mp3`** — the one-shot behind **Ready up** in the room
  (`src/views/Room.tsx`), replacing the `room.ready.me` synth event. The
  opponent's ready and the both-ready chime stay synth.

- **`case-tick.mp3`** — one tick of the reel, sliced from a real CS:GO
  case-open recording. It backs the `spin.tick` recipe rather than a button:
  `map.ts` reads it through `getSample` and plays it at `opts.pitch`, so the
  reel's accelerate/decelerate voicing still comes from `tickParams` and the
  measured gap between tile crossings.
- **`case-land.mp3`** — the reveal sting from the same recording, behind
  `spin.land`. `spin.reveal`'s per-leg arpeggio stays synth and layers on top
  of it; the sting is mixed as the bed, not the melody.

Both are cut from **`csgo-case-open.mp3`** in the repo root, an
owner-supplied recording of one real case open (12.888s, 48kHz stereo):

| file | in | length | channels |
|---|---|---|---|
| `case-tick.mp3` | 6.935s | 0.075s | mono |
| `case-land.mp3` | 7.885s | 1.300s | stereo |

Both are mastered to −3 dBFS. **`slice-case-open.sh` in this directory
regenerates them** — put the recording back at the repo root and run
`bash src/assets/slice-case-open.sh`. The script carries the analysis of the
take and the reasoning for both cut points; the short version is that the tick
comes from 6.94s because that is the one hit in the whole recording with
silence on both sides of it (the main run never returns to the floor between
ticks), and the sting is cut to 1.30s with a long out-fade because its natural
tail runs to ~12.2s and would still be ringing under the next leg.

Unlike the clips above, these two are **not** required for the sound to work:
`map.ts` keeps the original synth recipes as the fallback path, so a checkout
without them — or an offline tab, or the first moments before the decode lands
— still ticks and still lands. They replace a synth voice; they are not the
only one.

Each file is served only if it exists — the server's `/assets` allowlist in
`index.ts` answers 404 otherwise, and the engine treats a 404 as silence, so a
missing clip costs a quiet button and nothing else.

`*.mp3` is gitignored, so a licensed track stays on the machine that owns the
licence and is never committed or pushed.

- `exo-kill-1.mp3` — "Done studying → pick a parlay" (Study)
- `exo-kill-3.mp3` — "Both ready → lucky spin" (Room)
