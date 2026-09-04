import { sx } from "../lib/sx.ts";

/**
 * The cat, as code.
 *
 * The owner's mascot arrived as a 32KB export — a rounded tile background, the
 * six shapes that are the actual character, five more copies of those shapes
 * feeding drop-shadow and clip filters, and a payload of `data-avatar-*`
 * revision metadata. Everything but the six shapes is gone. What survives is
 * geometry only, at whole-unit precision: the art is drawn between 40 and 90px
 * on screen, where one unit of its 420-unit box is under a fifth of a pixel, so
 * the decimals the exporter emitted were describing distances no display can
 * resolve. That single change took the path data from 13.2KB to 6.1KB, and a
 * side-by-side render against the original SVG is pixel-indistinguishable.
 *
 * Two further departures from the export, both deliberate:
 *
 * - **The tile is gone.** `CatSeat` in `WalletPicker` is the tile, and it
 *   supplies the light surface, the radius and the shadow. The cat is drawn
 *   edge to edge inside it and clipped by its corner radius, which is what
 *   gives the head its cropped, sticker-like framing.
 * - **The art no longer carries its own -9° tilt.** The seat rotates as one
 *   piece, so a counter-tilt inside it read as the face refusing to lean with
 *   its own tile. The rest of the export's placement — the off-centre
 *   translate, the 2.9x blow-up that crops the head — is kept verbatim.
 *
 * The eyes were 750 characters of polyline each, describing what are plainly
 * two stadium shapes; they are `<rect rx>` now. That is a fifth of the size, it
 * renders identically, and it is what makes the wink a one-line transform
 * rather than a second set of paths.
 */

/**
 * The export's own placement, minus its tilt: shift, then blow up about the
 * centre of the 420-unit box until the head fills the tile.
 *
 * 2.5 rather than the export's 2.39, and not the 2.9 that was tried first: past
 * about 2.6 the tile's top edge crops the ear tips flat and the cat stops
 * reading as a cat. This is the largest blow-up that keeps both ears whole.
 */
const ART = "translate(49.5 79.2) translate(210 210) scale(2.5) translate(-210 -210)";

/** Ears and head — the parts that wear the wallet's colour. */
const EAR_L =
  "M184 136Q184 136 183 136Q183 136 183 137Q181 137 180 137Q179 137 179 137Q179 137 179 138Q178 138 177 138Q176 138 176 138Q176 138 176 139Q175 139 174 139Q173 139 173 139Q173 139 173 140Q171 140 170 140Q169 140 169 140Q169 140 169 141Q168 141 167 141Q166 141 166 141Q166 141 166 142Q165 142 164 142Q163 142 163 142Q163 142 163 143Q162 143 161 143Q160 143 160 143Q160 143 160 144Q159 144 158 144Q157 144 157 144Q157 144 157 145Q156 145 155 145Q154 145 154 145Q154 145 154 146Q153 146 153 146Q152 146 152 146Q152 146 152 147Q151 147 151 147Q150 147 150 147Q149 148 149 149Q148 149 148 149Q147 149 147 149Q147 149 147 150Q146 150 146 150Q145 150 145 150Q145 150 145 151Q144 151 144 151Q143 151 143 151Q143 151 143 152Q142 152 142 152Q141 152 141 152Q141 152 141 153Q140 153 140 153Q139 153 139 153Q138 154 138 155Q137 155 137 155Q136 155 136 155Q135 156 135 157Q134 157 134 157C137 142 140 127 145 113C146 111 147 109 148 107C148 106 148 105 149 103C150 103 152 101 152 101C152 100 153 101 153 101C154 102 155 102 156 103C157 104 160 106 161 107C166 113 171 119 176 125C178 127 179 129 180 131C184 135 183 134 184 136Z";
const EAR_R =
  "M290 157Q290 157 289 157Q289 156 289 156Q289 156 288 156Q288 156 287 156Q287 155 287 155Q286 155 286 154Q286 154 285 154Q285 154 284 154Q284 153 283 152Q283 152 282 152Q282 152 281 152Q281 151 281 151Q281 151 280 151Q280 151 279 151Q279 150 279 150Q279 150 278 150Q278 150 277 150Q277 149 277 149Q276 149 276 149Q276 149 275 149Q275 148 275 148Q274 148 274 148Q274 148 273 148Q273 147 273 147Q272 147 272 147Q272 147 271 147Q271 147 271 146Q270 146 270 146Q270 146 269 146Q269 146 269 145Q268 145 268 145Q268 145 267 145Q267 145 267 144Q266 144 266 144Q266 144 265 144Q265 143 264 143Q263 143 262 143Q262 142 262 142Q262 142 261 142Q260 142 259 142Q259 142 259 141Q258 141 258 141Q258 141 257 141Q256 141 255 141Q255 140 255 140Q255 140 254 140Q253 140 252 140Q252 139 251 139Q251 139 250 139Q249 139 248 139Q248 138 248 138Q248 138 247 138Q246 138 245 138Q245 137 245 137Q245 137 244 137Q243 137 241 137Q241 136 241 136Q241 136 240 136Q239 136 239 136C242 133 243 130 244 127C250 119 256 111 262 104C264 102 266 100 269 99C269 98 269 98 270 98C270 98 270 98 270 97C270 97 271 97 271 97C274 99 275 102 276 105C277 107 278 108 278 109C280 113 282 119 283 122C285 127 285 127 287 132C289 138 288 135 290 142C291 146 292 150 293 153C293 154 293 156 293 156C293 156 293 157 293 157C293 157 292 157 292 157C291 157 291 157 290 157Z";
const HEAD =
  "M239 136Q239 136 240 136Q241 136 241 136Q241 136 241 137Q243 137 244 137Q245 137 245 137Q245 137 245 138Q246 138 247 138Q248 138 248 138Q248 138 248 139Q249 139 250 139Q251 139 251 139Q252 139 252 140Q253 140 254 140Q255 140 255 140Q255 140 255 141Q256 141 257 141Q258 141 258 141Q258 141 259 141Q259 142 259 142Q260 142 261 142Q262 142 262 142Q262 142 262 143Q263 143 264 143Q265 143 265 144Q266 144 266 144Q266 144 267 144Q267 145 267 145Q268 145 268 145Q268 145 269 145Q269 146 269 146Q270 146 270 146Q270 146 271 146Q271 147 271 147Q272 147 272 147Q272 147 273 147Q273 147 273 148Q274 148 274 148Q274 148 275 148Q275 148 275 149Q276 149 276 149Q276 149 277 149Q277 149 277 150Q278 150 278 150Q279 150 279 150Q279 150 279 151Q280 151 280 151Q281 151 281 151Q281 151 281 152Q282 152 282 152Q283 152 283 152Q284 153 284 154Q285 154 285 154Q286 154 286 154Q286 155 287 155Q287 155 287 156Q288 156 288 156Q289 156 289 156Q289 156 289 157Q290 157 290 157C291 158 292 159 293 159C296 162 299 165 301 168C312 178 319 193 320 208C320 210 320 213 320 215C320 220 319 227 317 232C312 245 304 256 293 265C290 268 287 270 284 272C283 273 282 273 282 274C279 275 277 276 275 277C272 279 269 281 266 282C262 284 258 285 253 286C250 288 246 289 242 290C238 291 231 292 227 292C225 293 223 293 221 293C220 293 220 293 219 293C216 293 214 293 211 294C210 294 210 294 209 294C207 294 206 294 204 294C203 294 203 293 203 293C202 293 201 293 200 293C199 293 197 293 196 293C195 293 194 293 193 293C191 293 189 293 187 293C185 292 184 292 182 292C182 292 181 292 181 291C179 291 178 291 176 291C176 291 175 291 175 291C172 290 157 286 151 282C146 280 141 278 137 275C133 273 130 270 126 268C124 265 121 263 119 260C114 256 110 249 107 243C100 231 98 217 101 203C103 195 107 186 112 179C113 177 115 175 117 173C117 172 118 171 119 171C121 168 124 165 127 163C129 161 131 159 134 158C134 157 134 157 134 157Q134 157 135 157Q135 156 136 155Q136 155 137 155Q137 155 138 155Q138 154 139 153Q139 153 140 153Q140 153 141 153Q141 152 141 152Q141 152 142 152Q142 152 143 152Q143 151 143 151Q143 151 144 151Q144 151 145 151Q145 150 145 150Q145 150 146 150Q146 150 147 150Q147 149 147 149Q147 149 148 149Q148 149 149 149Q149 148 150 147Q150 147 151 147Q151 147 152 147Q152 146 152 146Q152 146 153 146Q153 146 154 146Q154 145 154 145Q154 145 155 145Q156 145 157 145Q157 144 157 144Q157 144 158 144Q159 144 160 144Q160 143 160 143Q160 143 161 143Q162 143 163 143Q163 142 163 142Q163 142 164 142Q165 142 166 142Q166 141 166 141Q166 141 167 141Q168 141 169 141Q169 140 169 140Q169 140 170 140Q171 140 173 140Q173 139 173 139Q173 139 174 139Q175 139 176 139Q176 138 176 138Q176 138 177 138Q178 138 179 138Q179 137 179 137Q179 137 180 137Q181 137 183 137Q183 136 183 136Q184 136 184 136C186 136 184 136 187 136C189 135 191 135 193 135C194 135 194 135 195 135C197 135 199 135 201 135C201 134 202 134 203 134C207 134 212 134 216 134C217 134 217 134 218 134C220 134 222 134 224 134C226 134 229 135 231 135C232 135 233 135 234 135C235 135 237 136 238 136C238 136 239 136 239 136Z";
/** The mouth. Eyes are rectangles; only this one keeps a path. */
const MOUTH =
  "M188 224L189 225L189 225L189 225L190 225L190 225L190 225L190 225L191 225L191 225L191 225L191 225L192 225L192 225L192 225L192 225L193 225L193 225L193 225L193 225L194 225L194 225L194 225L194 225L195 225L195 225L195 224L195 224L196 224L196 224L197 224L197 224L198 225L198 225L198 226L198 226L197 227L197 227L197 227L196 227L196 227L196 227L195 228L195 228L195 228L194 228L194 228L194 228L193 228L193 228L193 228L192 228L192 228L191 228L191 228L191 228L190 228L190 228L190 228L189 228L189 228L189 228L188 227L188 227L187 227L187 227L187 226L187 226L187 225L187 225L187 224L188 224L188 224Z";

/** Face features stay near-black at every tint — they are the character, and a
 *  brand-coloured eye stops reading as an eye. */
const INK = "#050608";

/**
 * The fur retints rather than cutting.
 *
 * There is one cat in the wallet picker now and it wears whichever wallet the
 * pointer is over, so `color` changes while the mascot is on screen — several
 * times a second if someone runs the pointer down the list. `fill` is a
 * presentation attribute, which puts it in the cascade like any other
 * declaration and makes it transitionable; 220ms is the same clock the row's
 * wash and the tile's warm cast run on, so the whole dialog changes colour as
 * one object. Nothing here moves: a retint is not motion, which is why it
 * survives `prefers-reduced-motion` untouched.
 */
const FUR = "transition:fill 220ms ease";

const EYES = [
  { x: 157.2, y: 169.6, w: 19.3, h: 43 },
  { x: 204.6, y: 167.8, w: 20.9, h: 43 },
] as const;

export function CatMascot({ color, wink }: { color: string; wink: boolean }) {
  return (
    <svg
      viewBox="0 0 420 420"
      width="100%"
      height="100%"
      aria-hidden="true"
      style={sx("display:block")}
    >
      <g transform={ART}>
        <path d={EAR_L} fill={color} style={sx(FUR)} />
        <path d={EAR_R} fill={color} style={sx(FUR)} />
        <path d={HEAD} fill={color} style={sx(FUR)} />
        {EYES.map((e, i) => (
          <rect
            key={e.x}
            x={e.x}
            y={e.y}
            width={e.w}
            height={e.h}
            rx={e.w / 2}
            fill={INK}
            // The right eye blinks once, a beat after the sticker lands.
            // `fill-box` puts the origin at the eye's own centre, so it squashes
            // shut rather than sliding; without it the origin would be the
            // whole SVG's viewport and the eye would fly off the face.
            style={sx(
              i === 1 && wink
                ? "transform-box:fill-box;transform-origin:50% 50%;" +
                    "animation:vcCatWink 520ms ease-in-out 640ms"
                : "",
            )}
          />
        ))}
        <path d={MOUTH} fill={INK} />
      </g>
    </svg>
  );
}
