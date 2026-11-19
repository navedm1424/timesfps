import type {CSSValue} from "../dom/mapping.ts";
import type {Progress} from "../types.ts";
import {getOrInsertComputed, partitionPoint} from "../utils/collections.ts";
import {clamp, invLerp, lerp} from "../utils/math.ts";
import {type AlignedNumbers, alignedNumbersOf, checkedTextOf} from "./css-values.ts";

/** A value at an offset of an easing's progress. */
export interface ScaleStop {
    offset: Progress;
    value: CSSValue;
}

/** A stop with its value as checked CSS text. */
interface TextStop {
    offset: Progress;
    text: string;
}

/**
 * One property's values on one element, at offsets of an easing's progress, as CSS text.
 * Between two stops, the value runs linearly with the offset, and past the outer ones it continues the nearest two.
 */
export class NativeEffectScale {
    private readonly stops: readonly TextStop[];
    /** The numbers of the two stops that end at each index, once a value between them is asked for. */
    private readonly numbersByEndIndex = new Map<number, AlignedNumbers>();

    /** `stops` are in order; throws for a value the property doesn't take. */
    constructor(private readonly element: Element, private readonly property: string, stops: readonly ScaleStop[]) {
        this.stops = stops.map(({offset, value}) => ({offset, text: checkedTextOf(property, value)}));
    }

    /** The offsets of its stops, in order. */
    get stopOffsets(): Progress[] {
        return this.stops.map(({offset}) => offset);
    }

    /** The value at `offset`: a stop's own at a stop, and otherwise a number in the unit the stops around it come to. */
    valueAt(offset: Progress): string {
        const {stops} = this;
        const atOrAfterIndex = partitionPoint(stops, stop => stop.offset >= offset);
        const stopThere = stops[atOrAfterIndex];
        if (stopThere?.offset === offset) return stopThere.text;
        if (stops.length === 1) return stops[0]!.text;

        const endIndex = clamp(atOrAfterIndex, 1, stops.length - 1);
        return this.valueBetween(endIndex, invLerp(stops[endIndex - 1]!.offset, stops[endIndex]!.offset, offset));
    }

    /** The same values from its end to its start: each stop moved from its offset to 1 minus it. */
    flip(): NativeEffectScale {
        const stops = this.stops.map(({offset, text}) => ({offset: 1 - offset, value: text})).reverse();
        return new NativeEffectScale(this.element, this.property, stops);
    }

    /** A scale whose every value is this one's at `offset`. */
    heldAt(offset: Progress): NativeEffectScale {
        const value = this.valueAt(offset);
        return new NativeEffectScale(this.element, this.property, [{offset: 0, value}, {offset: 1, value}]);
    }

    /** The value `amount` of the way from the stop before `endIndex` to the one at it; either one at its end, or where both are the same. */
    private valueBetween(endIndex: number, amount: number): string {
        const from = this.stops[endIndex - 1]!.text;
        const to = this.stops[endIndex]!.text;
        if (amount === 0 || from === to) return from;
        if (amount === 1) return to;

        const numbers = getOrInsertComputed(this.numbersByEndIndex, endIndex, () => alignedNumbersOf(this.element, this.property, [from, to]));
        return `${lerp(numbers.numbersByText.get(from)!, numbers.numbersByText.get(to)!, amount)}${numbers.unit}`;
    }
}
