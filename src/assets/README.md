# src/assets

Optional, operator-supplied media. Nothing here is required to run or test the app.

- **`room-inspect.mp3`** — the looping track behind the ready room (a CS:GO
  case-inspect mood). Drop the file in with exactly that name and it is served
  at `/assets/room-inspect.mp3`; leave it out and the room is simply silent.

`*.mp3` is gitignored, so a licensed track stays on the machine that owns the
licence and is never committed or pushed.
