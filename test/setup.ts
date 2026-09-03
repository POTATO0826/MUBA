import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });

// happy-dom has no WebGL or 2D canvas backend. Both visual components already
// bail out when `getContext` returns null, which is the path taken here — the
// tests exercise layout and state, not the shaders.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
}

// React 19 checks for this flag when act() wraps updates.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
