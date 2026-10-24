import type {CSSValue} from "../dom/mapping.ts";
import {NumericStops} from "../resolution/stops.ts";
import type {EntryPath} from "../sequence-timing.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Seconds} from "../types.ts";
import {landsOnStops} from "./native-effects.ts";
import type {PlacedEffect, ResolvedEffect} from "./tracks.ts";

/** What resolving values needs from the page. */
export interface CSSValueResolver {
    /** The value as CSS text; a bare number takes the property's default unit. */
    textOf(property: string, value: CSSValue): string;
    /** The property's value on the element as it is now. */
    currentValueOf(element: Element, property: string): string;
    /** Whether the property takes the value. */
    accepts(property: string, text: string): boolean;
    /** The value's computed form on the element. */
    resolve(element: Element, property: string, text: string): string;
}

/** Takes values as plain numbers without a unit, for tracks that stand in for no property of an element. */
export const plainNumberResolver: CSSValueResolver = {
    textOf: (_property, value) => String(value),
    currentValueOf: (_element, property) => {
        throw new Error(`"${property}" has no current value off the page, so it needs a value at 0.`);
    },
    accepts: () => true,
    resolve: (_element, _property, text) => text
};

/** An entry's values on one track: their CSS text, and their numbers in one unit once the entry's chain is resolved to one. */
export class EntryValues {
    constructor(
        private readonly textOfValue: (value: CSSValue) => string,
        /** The value underneath as the entry starts: its text, or only its number when the track is between stops then. */
        private readonly underneath: { text: string | undefined; number: number | undefined },
        private readonly numbersByText: ReadonlyMap<string, number> | undefined
    ) {}

    /** A `null` value is the value underneath as the entry starts. */
    textOf(value: CSSValue | null): string {
        const text = value === null ? this.underneath.text : this.textOfValue(value);
        if (text === undefined) throw new Error("The value underneath has no text, only a number.");
        return text;
    }

    numberOf(value: CSSValue | null): number {
        const number = value === null && this.underneath.number !== undefined ? this.underneath.number : this.numbersByText?.get(this.textOf(value));
        if (number === undefined) throw new Error(`The value "${this.textOf(value)}" hasn't been resolved to a number.`);
        return number;
    }

    numericStopsOf(stops: TweenStops): NumericStops {
        return new NumericStops(stops.stops.map(({offset, value}) => ({offset, value: this.numberOf(value)})));
    }
}

/** An entry's effects on one track, which share its stops. */
interface EntryEffects {
    path: EntryPath | undefined;
    stops: TweenStops;
    effects: PlacedEffect[];
    /** When its first effect starts. */
    start: Seconds;
    /** Where its first effect is declared on the track. */
    declaredIndex: number;
}

/** A chain's values as numbers in one unit, by their text. */
interface ChainNumbers {
    unit: string;
    numbersByText: ReadonlyMap<string, number>;
}

/**
 * Resolves the values of a track's effects, and gives each effect its unit, or none when its values pass through to WAAPI as CSS text.
 * An entry without a value at 0 starts from the value the track shows as it starts, which makes it depend on the effect showing it.
 * Entries that depend on each other make a chain, and a chain whose first entry has no value at 0 starts from the property's current value.
 * Values pass through when every keyframe of their effect lands on a stop with text; a chain with any other effect is resolved to numbers in one unit.
 */
export function resolveEffectChains(element: Element, property: string, effects: readonly PlacedEffect[], resolver: CSSValueResolver): ResolvedEffect[] {
    const textOfValue = (value: CSSValue) => resolver.textOf(property, value);
    const entries = entryEffectsOf(effects);
    const declaredIndices = new Map(effects.map((effect, index) => [effect, index]));
    const chains = new Map<EntryEffects, EntryEffects[]>();
    const predecessors = new Map<EntryEffects, PlacedEffect>();
    const ordered = [...entries].sort((first, second) => first.start - second.start || first.declaredIndex - second.declaredIndex);
    ordered.forEach((entry, index) => {
        const predecessor = entry.stops.startValue !== null
            ? undefined
            : shownEffectAt(entry.start, ordered.slice(0, index), declaredIndices);
        if (!predecessor) {
            chains.set(entry, [entry]);
            return;
        }
        const chain = chains.get(entryOf(predecessor, entries))!;
        chain.push(entry);
        chains.set(entry, chain);
        predecessors.set(entry, predecessor);
    });

    const underneathTexts = new Map<EntryEffects, string>();
    const startsBetweenStops = new Set<EntryEffects>();
    const textShownAt = (effect: PlacedEffect, time: Seconds): string | undefined => {
        const value = stopValueShownAt(effect, time);
        if (value === undefined) return undefined;
        return value === null ? underneathTexts.get(entryOf(effect, entries)) : textOfValue(value);
    };
    for (const entry of ordered) {
        if (entry.stops.startValue !== null) continue;
        const predecessor = predecessors.get(entry);
        const startText = predecessor ? textShownAt(predecessor, entry.start) : resolver.currentValueOf(element, property);
        if (startText === undefined) startsBetweenStops.add(entry);
        else underneathTexts.set(entry, startText);
    }

    const givenTextsOf = ({stops}: EntryEffects) => stops.stops.flatMap(({value}) => value === null ? [] : [textOfValue(value)]);
    const passing = new Set(effects.filter(effect => landsOnStops(effect) && !startsBetweenStops.has(entryOf(effect, entries))));
    const numbersByChain = new Map<EntryEffects[], ChainNumbers>();
    for (const chain of new Set(chains.values())) {
        if (chain.every(({effects}) => effects.every(effect => passing.has(effect)))) {
            checkGivenValues(property, chain.flatMap(givenTextsOf), resolver);
            continue;
        }
        const texts = chain.flatMap(entry => [...givenTextsOf(entry), ...(underneathTexts.has(entry) ? [underneathTexts.get(entry)!] : [])]);
        numbersByChain.set(chain, resolveChainValues(element, property, underneathTexts.get(chain[0]!), texts, resolver));
    }

    const valuesByEntry = new Map<EntryEffects, EntryValues>();
    for (const entry of ordered) {
        const underneathNumber = startsBetweenStops.has(entry)
            ? valueShownAt(predecessors.get(entry)!, entry.start, valuesByEntry.get(entryOf(predecessors.get(entry)!, entries))!)
            : undefined;
        const underneath = {text: underneathTexts.get(entry), number: underneathNumber};
        valuesByEntry.set(entry, new EntryValues(textOfValue, underneath, numbersByChain.get(chains.get(entry)!)?.numbersByText));
    }

    return effects.map(effect => {
        const entry = entryOf(effect, entries);
        return {...effect, unit: passing.has(effect) ? undefined : numbersByChain.get(chains.get(entry)!)!.unit, values: valuesByEntry.get(entry)!};
    });
}

function entryEffectsOf(effects: readonly PlacedEffect[]): EntryEffects[] {
    const entries = new Map<EntryPath | undefined, EntryEffects>();
    effects.forEach((effect, index) => {
        const entry = entries.get(effect.path);
        if (entry) {
            entry.effects.push(effect);
            entry.start = Math.min(entry.start, effect.delay);
        } else
            entries.set(effect.path, {path: effect.path, stops: effect.entryStops, effects: [effect], start: effect.delay, declaredIndex: index});
    });
    return [...entries.values()];
}

function entryOf(effect: PlacedEffect, entries: readonly EntryEffects[]): EntryEffects {
    return entries.find(entry => entry.path === effect.path)!;
}

/** The effect declared last among the entries' effects that show a value at `time`. */
function shownEffectAt(time: Seconds, entries: readonly EntryEffects[], declaredIndices: ReadonlyMap<PlacedEffect, number>): PlacedEffect | undefined {
    return entries
        .flatMap(({effects}) => effects)
        .filter(effect => iterationTimeAt(effect, time) !== undefined)
        .sort((first, second) => declaredIndices.get(first)! - declaredIndices.get(second)!)
        .at(-1);
}

function valueShownAt(effect: PlacedEffect, time: Seconds, values: EntryValues): number | undefined {
    const iterationTime = iterationTimeAt(effect, time);
    return iterationTime === undefined ? undefined : effect.run.valueAt(iterationTime, stops => values.numericStopsOf(stops));
}

function stopValueShownAt(effect: PlacedEffect, time: Seconds): CSSValue | null | undefined {
    const iterationTime = iterationTimeAt(effect, time);
    return iterationTime === undefined ? undefined : effect.run.stopValueAt(iterationTime);
}

/** Throws for a given value the property doesn't take, without resolving it. */
function checkGivenValues(property: string, givenTexts: readonly string[], resolver: CSSValueResolver): void {
    for (const text of givenTexts) {
        if (!resolver.accepts(property, text))
            throw new TypeError(`"${text}" isn't a value "${property}" takes.`);
    }
}

/** Where in its run the effect is at `time`, as WAAPI works it out, or undefined when it shows nothing then. */
function iterationTimeAt({delay, duration, iterations, direction, fill}: PlacedEffect, time: Seconds): Seconds | undefined {
    const elapsed = time - delay;
    const activeDuration = duration === 0 ? 0 : duration * iterations;
    let iteration: number;
    let iterationTime: Seconds;
    if (elapsed < 0) {
        if (fill !== 'backwards' && fill !== 'both') return undefined;
        [iteration, iterationTime] = [0, 0];
    } else if (elapsed >= activeDuration) {
        if (fill !== 'forwards' && fill !== 'both') return undefined;
        [iteration, iterationTime] = [Math.max(Math.ceil(iterations) - 1, 0), duration];
    } else {
        iteration = Math.floor(elapsed / duration);
        iterationTime = elapsed - iteration * duration;
    }
    const backwards = direction === 'reverse'
        || (direction === 'alternate' && iteration % 2 === 1)
        || (direction === 'alternate-reverse' && iteration % 2 === 0);
    return backwards ? duration - iterationTime : iterationTime;
}

/**
 * Resolves the texts of the chain's values to numbers in one unit.
 * When its first entry has no value at 0, the chain starts from the property's current value, whose unit the rest must resolve to.
 * Otherwise values that are all numbers in one unit are taken as they are; failing that, the expressions are resolved, and failing that, every value is.
 */
function resolveChainValues(element: Element, property: string, currentText: string | undefined, texts: readonly string[], resolver: CSSValueResolver): ChainNumbers {
    const resolvedNumericOf = (text: string): Numeric => {
        if (!resolver.accepts(property, text))
            throw new TypeError(`"${text}" isn't a value "${property}" takes.`);
        const resolved = resolver.resolve(element, property, text);
        const numeric = parseNumeric(resolved);
        if (!numeric) throw new TypeError(`"${text}" resolves to "${resolved}" for "${property}", which isn't a single number with a unit.`);
        return numeric;
    };
    const chainNumbersOf = (unit: string, numerics: readonly Numeric[]): ChainNumbers =>
        ({unit, numbersByText: new Map(texts.map((text, index) => [text, numerics[index]!.value]))});

    if (currentText !== undefined) {
        const currentNumeric = parseNumeric(currentText);
        if (!currentNumeric)
            throw new Error(`"${property}" is "${currentText}" now, which isn't a single number with a unit, so it needs a value at 0.`);
        return chainNumbersOf(currentNumeric.unit, texts.map(text => {
            const given = parseNumeric(text);
            const numeric = given?.unit === currentNumeric.unit ? given : resolvedNumericOf(text);
            if (numeric.unit !== currentNumeric.unit)
                throw new Error(`"${text}" resolves to a value in "${numeric.unit}" for "${property}", whose current value is in "${currentNumeric.unit}". ${sameUnitAdvice}`);
            return numeric;
        }));
    }

    const given = texts.map(parseNumeric);
    const givenUnits = new Set(given.map(numeric => numeric?.unit));
    if (givenUnits.size === 1 && !givenUnits.has(undefined)) {
        const unit = given[0]!.unit;
        if (!resolver.accepts(property, `1${unit}`))
            throw new TypeError(`"${property}" doesn't take values in "${unit}".`);
        return chainNumbersOf(unit, given as Numeric[]);
    }

    let numerics = texts.map((text, index) => given[index] ?? resolvedNumericOf(text));
    if (new Set(numerics.map(({unit}) => unit)).size > 1)
        numerics = texts.map((text, index) => given[index] ? resolvedNumericOf(text) : numerics[index]!);
    const units = new Set(numerics.map(({unit}) => unit));
    if (units.size > 1)
        throw new Error(`The values of "${property}" resolve to different units: ${[...units].map(unit => `"${unit}"`).join(', ')}. ${sameUnitAdvice}`);
    return chainNumbersOf(numerics[0]!.unit, numerics);
}

const sameUnitAdvice = "Use values in one unit, or expressions that resolve to one. "
    + "To have values passed through as they are, use only native easings (cubic Bézier, steps or linear), "
    + "give no values between 0 and 1 to an animation whose repeats are played as keyframes: one with a repeat delay or in mirror mode, "
    + "and don't start an entry without a value at 0 while the one under it is between two of its values.";

interface Numeric {
    value: number;
    unit: string;
}

const numericPattern = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)\s*$/i;

/** A number with an optional unit, the only form whose value is known without resolving it. */
export function parseNumeric(text: string): Numeric | undefined {
    const [, number, unit] = numericPattern.exec(text) ?? [];
    return number === undefined ? undefined : {value: Number(number), unit: unit!.toLowerCase()};
}
