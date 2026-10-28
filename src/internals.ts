// The internals `site/` uses; the build leaves this file out.
export {PRECISION} from "./constants.ts";
export {CubicBezierEasing, SpringEasing} from "./easing.ts";
export {resolveTransition} from "./transition.ts";
export {SpringSplineFitter} from "./waapi/spring-fit.ts";
export {plainNumberResolver} from "./waapi/css-values.ts";
export {plan} from "./resolution/plan.ts";
export {naming} from "./naming.ts";
export {TracksResolver} from "./resolution/tracks.ts";
export {NativeEffectsResolver} from "./waapi/tracks.ts";
export type {NativeKeyframe} from "./waapi/native-effects.ts";
