import {Animator} from "../animator.ts";
import {type AnimatorOptions, resolveTargets, type Target} from "../dom/mapping.ts";
import {plan} from "../resolution/plan.ts";
import {naming} from "../naming.ts";
import {TracksResolver} from "../resolution/tracks.ts";
import type {Definition} from "../sequence.ts";
import {AnimationControls} from "./controls.ts";
import {domValueResolver, keyframePropertyOf} from "./css-values.ts";
import {cssEasingOf} from "./native-easing.ts";
import {type AnimationTracks, NativeEffectsResolver} from "./tracks.ts";

/** An animator whose selectors and target functions look for elements in the scope given. */
export function animator(options: AnimatorOptions = {}): Animator {
    return new WAAPIAnimator(options);
}

/**
 * Plays definitions on elements with WAAPI.
 * It plans the definition, resolving its targets, builds the plan's tracks, turns them into WAAPI effects, and creates an animation for each effect.
 */
export class WAAPIAnimator extends Animator {
    readonly #options: AnimatorOptions;

    constructor(options: AnimatorOptions = {}) {
        super();
        this.#options = options;
    }

    protected animateDefinition(definition: Definition): AnimationControls {
        const scope = this.#options.scope ?? document.documentElement;
        const targetsByTarget = new Map<Target, readonly Element[]>();
        /** Resolves each target once, however many times a sequence plays it. */
        function targetsResolver(target: Target) {
            let targets = targetsByTarget.get(target);
            if (!targets) targetsByTarget.set(target, targets = resolveTargets(target, scope));
            return targets;
        }
        const tracks = NativeEffectsResolver.resolve(new TracksResolver(plan(definition, targetsResolver), naming).resolve(), domValueResolver);
        return new AnimationControls(WAAPIAnimator.nativeAnimationsOf(tracks));
    }

    /** Creates the effects in their tracks' order, which is the order they show over each other in; each is named by its track entry and its property. */
    private static nativeAnimationsOf(tracks: AnimationTracks): Animation[] {
        return [...tracks].flatMap(([element, effectsByProperty]) => Object.entries(effectsByProperty).flatMap(([property, effects]) => {
            const keyframeProperty = keyframePropertyOf(property);
            return effects.map(({keyframes, easing, delay, duration, iterations, direction, fill, name}) => {
                const animation = element.animate(
                    keyframes.map(keyframe => ({
                        offset: keyframe.offset,
                        [keyframeProperty]: keyframe.value,
                        ...(keyframe.easing && {easing: cssEasingOf(keyframe.easing)})
                    })),
                    {delay: delay * 1000, duration: duration * 1000, iterations, direction, fill, easing: cssEasingOf(easing)}
                );
                animation.id = naming.animationIdOf(name, property);
                return animation;
            });
        }));
    }
}
