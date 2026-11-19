import type {CSSValue} from "../dom/mapping.ts";
import type {TrackStop} from "../tracks/track-entries.ts";
import type {Progress} from "../types.ts";
import {partitionPoint} from "../utils/collections.ts";
import {clamp, invLerp, lerp} from "../utils/math.ts";
import type {CSSValueResolver} from "./css-values.ts";

/**
 * One property's values on one element as CSS text: a given value as it is, checked; the property's current value as it's computed now;
 * and a value between two as a number in the unit both come to. Given values and the current value are each worked out once.
 */
export class TrackValues {
    private readonly givenTexts = new Map<CSSValue, string>();
    private currentText: string | undefined;

    constructor(private readonly valueResolver: CSSValueResolver, private readonly element: Element, private readonly property: string) {}

    /** A given value as CSS text; throws for one the property doesn't take. */
    textOf(value: CSSValue): string {
        let text = this.givenTexts.get(value);
        if (text === undefined) {
            text = this.valueResolver.textOf(this.property, value);
            this.valueResolver.validate(this.property, text);
            this.givenTexts.set(value, text);
        }
        return text;
    }

    /** The property's computed value on the element, read once. */
    get currentValue(): string {
        return this.currentText ??= this.valueResolver.currentValueOf(this.element, this.property);
    }

    /**
     * The stops' value at `progress`: a stop's own at a stop; otherwise the value between the stops around it,
     * which runs linearly with the progress, or between the nearest two past either end.
     */
    textAt(stops: readonly TrackStop<string>[], progress: Progress): string {
        const atOrAfterIndex = partitionPoint(stops, stop => stop.offset >= progress);
        const stopThere = stops[atOrAfterIndex];
        if (stopThere?.offset === progress) return stopThere.value;
        if (stops.length === 1) return stops[0]!.value;

        const endIndex = clamp(atOrAfterIndex, 1, stops.length - 1);
        const start = stops[endIndex - 1]!;
        const end = stops[endIndex]!;
        return this.textBetween(start.value, end.value, invLerp(start.offset, end.offset, progress));
    }

    /** The value `amount` of the way from `from` to `to`, as a number in the unit both come to; either one at its end, or where both are the same. */
    textBetween(from: string, to: string, amount: number): string {
        if (amount === 0 || from === to) return from;
        if (amount === 1) return to;
        const {unit, numbersByText} = this.valueResolver.alignedNumbersOf(this.element, this.property, [from, to]);
        return `${lerp(numbersByText.get(from)!, numbersByText.get(to)!, amount)}${unit}`;
    }
}
