import type {Seconds} from "./types.ts";
import {checkNumber} from "./utils/validation.ts";

type AnchorMark = '<' | '>';
type AtPoint<Name extends string> = '' | AnchorMark | Name | `${Name}${AnchorMark}` | '<<' | '>>';

type AtOffsetSign = '+' | '-';
type AtSecondsOffset = `${AtOffsetSign}${number}`;
type AtReferencePercentageOffset = `${AtOffsetSign}${number}%`;
type AtSelfPercentageOffset = `${AtOffsetSign}=${number}%`;

/**
 * An entry's position as an expression: a reference point, then at most one offset of each kind, in this order.
 * The point is the previous entry's end (`>`, or nothing) or start (`<`), a named entry's end or start, the start of the sequence (`<<`), or the end of everything so far (`>>`).
 * The offsets are a share of the reference duration (`%`), a share of the inserted entry's duration (`=%`), and seconds, each with a sign.
 * A number is the same as `<<` with that offset in seconds.
 */
export type At<Name extends string = string> =
    | Seconds
    | `${AtPoint<Name>}${AtReferencePercentageOffset | ""}${AtSelfPercentageOffset | ""}${AtSecondsOffset | ""}`;

/** The span whose start or end is the reference point, and whose duration is the reference duration; everything so far spans from 0 to the latest end. */
export type PositionReference<Name extends string> =
    | { kind: 'previousEntry' }
    | { kind: 'entry'; name: Name }
    | { kind: 'everythingSoFar' };

export type PositionAnchor = 'start' | 'end';

/** A position's offset from its reference point, as the sum of one amount of each kind. */
export interface PositionOffset {
    seconds: Seconds;
    /** A fraction of the reference duration. */
    referenceFraction: number;
    /** A fraction of the inserted entry's duration. */
    selfFraction: number;
}

/** The parsed form of an `at`: a reference point and duration, and an offset from that point. */
export interface PositionDescriptor<Name extends string> {
    reference: PositionReference<Name>;
    anchor: PositionAnchor;
    offset: PositionOffset;
}

/** Where an entry starts in sequence-local time, and how long it lasts. */
export interface Span {
    start: Seconds;
    duration: Seconds;
}

/** The kinds of offset, in the order they're written. */
const offsetKindOrder = ['referenceFraction', 'selfFraction', 'seconds'] as const satisfies readonly (keyof PositionOffset)[];

const offsetKindLabels: { [Kind in keyof PositionOffset]: string } = {
    referenceFraction: "shares of the reference duration (`%`)",
    selfFraction: "shares of the entry's own duration (`=%`)",
    seconds: "seconds"
};

/** One offset: a sign, `=` for the inserted entry's duration, an amount whose exponent may have its own sign, and `%` for a share. */
const offsetPattern = /([+-])(=?)((?:[eE][+-]|[^+\-%])*)(%?)/y;

export function parsePositionDescriptor<Name extends string>(at: At<Name>): PositionDescriptor<Name> {
    if (typeof at === 'number')
        return {reference: {kind: 'everythingSoFar'}, anchor: 'start', offset: {seconds: at, referenceFraction: 0, selfFraction: 0}};
    const fail = (reason: string) => new SyntaxError(`Can't parse the position "${at}": ${reason}`);

    const [, name = '', mark, offsetsText = ''] = /^(\w*)(<<|>>|<|>)?(.*)$/s.exec(at) ?? [];
    if (name && (mark === '<<' || mark === '>>')) throw fail(`\`${mark}\` takes no name before it.`);
    const reference: PositionReference<Name> = mark === '<<' || mark === '>>' ? {kind: 'everythingSoFar'}
        : name ? {kind: 'entry', name: name as Name}
        : {kind: 'previousEntry'};
    const anchor: PositionAnchor = mark === '<' || mark === '<<' ? 'start' : 'end';

    const offset: PositionOffset = {seconds: 0, referenceFraction: 0, selfFraction: 0};
    let previousKindIndex = -1;
    offsetPattern.lastIndex = 0;
    while (offsetPattern.lastIndex < offsetsText.length) {
        const [, sign, equals, amountText = '', percent] = offsetPattern.exec(offsetsText) ?? [];
        if (!sign) throw fail("offsets need a sign, such as `+0.2`.");
        if (!amountText) throw fail(`\`${sign}\` needs an amount after it.`);
        if (equals && !percent) throw fail("`=` only goes with `%`.");
        const amount = Number(amountText);
        if (!amountText.trim() || Number.isNaN(amount)) throw fail(`"${amountText}" isn't a number.`);

        const kind: keyof PositionOffset = !percent ? 'seconds' : equals ? 'selfFraction' : 'referenceFraction';
        const kindIndex = offsetKindOrder.indexOf(kind);
        if (kindIndex === previousKindIndex) throw fail(`it has two offsets in ${offsetKindLabels[kind]}; add them into one.`);
        if (kindIndex < previousKindIndex) throw fail(`offsets go in this order: ${offsetKindOrder.map(kind => offsetKindLabels[kind]).join(', then ')}.`);
        previousKindIndex = kindIndex;

        const signed = sign === '-' ? -amount : amount;
        offset[kind] = percent ? signed / 100 : signed;
    }
    return {reference, anchor, offset};
}

/** A position's offsets must be finite, and the entry it refers to must come before it; `label` names the entry in messages. */
export function checkPositionDescriptor(position: PositionDescriptor<string>, earlierNames: readonly string[], label: string): void {
    const {seconds, referenceFraction, selfFraction} = position.offset;
    checkNumber(seconds, `${label}'s position offset in seconds`);
    checkNumber(referenceFraction, `${label}'s position offset in shares of the reference duration`);
    checkNumber(selfFraction, `${label}'s position offset in shares of its own duration`);
    if (position.reference.kind === 'entry' && !earlierNames.includes(position.reference.name))
        throw new Error(`${label}'s position refers to "${position.reference.name}", which isn't an earlier entry.`);
}

/**
 * The inserted entry's sequence-local start, which can be negative.
 * `referenceSpans` holds the earlier entries in order, so the last one is the previous entry; with none, the previous entry is the start of the sequence.
 */
export function resolvePosition<Name extends string>(
    descriptor: PositionDescriptor<Name>,
    referenceSpans: ReadonlyMap<Name, Span>,
    selfDuration: Seconds
): Seconds {
    const {start, duration} = referenceSpanOf(descriptor.reference, referenceSpans);
    const {seconds, referenceFraction, selfFraction} = descriptor.offset;
    const point = descriptor.anchor === 'start' ? start : start + duration;
    return point + seconds + referenceFraction * duration + selfFraction * selfDuration;
}

function referenceSpanOf<Name extends string>(reference: PositionReference<Name>, referenceSpans: ReadonlyMap<Name, Span>): Span {
    const spans = [...referenceSpans.values()];
    switch (reference.kind) {
        case 'previousEntry':
            return spans.at(-1) ?? {start: 0, duration: 0};
        case 'everythingSoFar':
            return {start: 0, duration: Math.max(0, ...spans.map(({start, duration}) => start + duration))};
        case 'entry': {
            const span = referenceSpans.get(reference.name);
            if (!span) throw new Error(`No entry named "${reference.name}" comes before this position.`);
            return span;
        }
    }
}
