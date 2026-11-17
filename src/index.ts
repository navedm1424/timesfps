export type {Progress, Seconds} from "./types.ts";

export type {CubicBezierEasingParams, StepPosition, StepsEasingParams} from "./easing.ts";
export {cubicBezier, steps} from "./easing-specifier.ts";
export type {EasingPreset, EasingSpecifier} from "./easing-specifier.ts";

export type {
    DurationSpringTransitionOptions, EasedTransitionOptions, PhysicalSpringTransitionOptions, SpringTransitionOptions, TransitionOptions,
    VisualSpringTransitionOptions
} from "./transition.ts";

export type {PlaybackOptions, RepeatMode, RepeatOptions, Stagger} from "./playback-options.ts";
export {stagger} from "./stagger.ts";
export type {StaggerOptions, StaggerOrigin, StaggerSpacing} from "./stagger.ts";

export {AnimationTiming} from "./animation-timing.ts";
export type {AnimationTimingOptions} from "./animation-timing.ts";
export type {At, PositionAnchor, PositionDescriptor, PositionOffset, PositionReference} from "./at.ts";
export {SequenceTiming} from "./sequence-timing.ts";
export type {
    AnimationTimingEntry, SequenceTimingBuilder, SequenceTimingEntries, SequenceTimingEntry, SubsequenceTimingEntry
} from "./sequence-timing.ts";

export type {AnimationMapping, AnimationValues, CSSSelector, CSSValue, AnimatorOptions, RawTweenStops, SequenceMapping, Target} from "./dom/mapping.ts";

export {animator} from "./waapi/animator.ts";
export type {Animator} from "./animator.ts";
export type {AnimationControls} from "./waapi/controls.ts";

export {animation} from "./animation.ts";
export type {AnimationDefinition} from "./animation.ts";
export {sequence} from "./sequence.ts";
export type {Definition, EntryPlacementOptions, SequenceDefinition, SequenceDefinitionBuilder} from "./sequence.ts";
