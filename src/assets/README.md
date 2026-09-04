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

Each file is served only if it exists — the server's `/assets` allowlist in
`index.ts` answers 404 otherwise, and the engine treats a 404 as silence, so a
missing clip costs a quiet button and nothing else.

`*.mp3` is gitignored, so a licensed track stays on the machine that owns the
licence and is never committed or pushed.
