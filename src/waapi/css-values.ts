import {checkNumber} from "../utils/validation.ts";
import type {CSSValue} from "../dom/mapping.ts";

/** Everything values need from where they play: their text, the property's current value, which values it takes, and their numbers in one unit. */
export interface CSSValueResolver {
    /** The value as CSS text; a bare number takes the property's default unit. */
    textOf(property: string, value: CSSValue): string;
    /** The property's computed value on the element as it is now. */
    currentValueOf(element: Element, property: string): string;
    /** Throws for a value the property doesn't take. */
    validate(property: string, text: string): void;
    /** The values as numbers in one unit, to interpolate between; throws when they don't come to one. */
    alignedNumbersOf(element: Element, property: string, texts: readonly string[]): AlignedNumbers;
}

export interface AlignedNumbers {
    unit: string;
    numbersByText: ReadonlyMap<string, number>;
}

/** The CSS name of a property given in camelCase; a custom property is already given by it. */
export function cssPropertyNameOf(property: string): string {
    if (property.startsWith('--')) return property;
    if (property === 'cssFloat') return 'float';
    if (property === 'cssOffset') return 'offset';
    const hyphenated = property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    return /^(webkit|moz|ms)-/.test(hyphenated) ? `-${hyphenated}` : hyphenated;
}

/** The name WAAPI keyframes take the property by; `offset` is the keyframe's own, so it and `float` take a prefix. */
export function keyframePropertyOf(property: string): string {
    if (property === 'float') return 'cssFloat';
    if (property === 'offset') return 'cssOffset';
    return property;
}

/** Resolves values on the page: its current values are computed styles, the values it takes are what `CSS.supports` takes, and its values compute through probes. */
export const domValueResolver: CSSValueResolver = {
    textOf: cssTextOf,
    currentValueOf: (element, property) => getComputedStyle(element).getPropertyValue(cssPropertyNameOf(property)).trim(),
    validate: (property, text) => {
        if (!CSS.supports(cssPropertyNameOf(property), text))
            throw new TypeError(`"${text}" isn't a value "${property}" takes.`);
    },
    alignedNumbersOf: (element, property, texts) => alignNumbers(property, texts, text => PropertyValueType.of(cssPropertyNameOf(property)).resolve(element, text))
};

/** Takes values as plain numbers without a unit, for tracks that stand in for no property of an element. */
export const plainNumberResolver: CSSValueResolver = {
    textOf: (_property, value) => String(value),
    currentValueOf: (_element, property) => {
        throw new Error(`"${property}" has no current value off the page, so it needs a value at each end.`);
    },
    validate: () => {},
    alignedNumbersOf: (_element, property, texts) => alignNumbers(property, texts, text => text)
};

/**
 * The texts as numbers in one unit: as they are when they're all numbers in one unit, or else as `computedTextOf` gives them.
 * Throws when even those don't share one unit.
 */
export function alignNumbers(property: string, texts: readonly string[], computedTextOf: (text: string) => string): AlignedNumbers {
    const distinctTexts = [...new Set(texts)];
    const given = distinctTexts.map(parseNumeric);
    const numerics = given.every(numeric => numeric !== undefined && numeric.unit === given[0]!.unit)
        ? given as Numeric[]
        : distinctTexts.map(text => {
            const computed = computedTextOf(text);
            const numeric = parseNumeric(computed);
            if (!numeric) throw new TypeError(`"${text}" comes to "${computed}" for "${property}", which isn't a single number with a unit. ${numbersAdvice}`);
            return numeric;
        });

    const units = new Set(numerics.map(({unit}) => unit));
    if (units.size > 1)
        throw new Error(`The values of "${property}" come to different units: ${[...units].map(unit => `"${unit}"`).join(', ')}. ${numbersAdvice}`);
    return {unit: numerics[0]!.unit, numbersByText: new Map(distinctTexts.map((text, index) => [text, numerics[index]!.value]))};
}

const numbersAdvice = "Use values in one unit, or expressions that come to one. "
    + "To have values passed through as they are, use only native easings (cubic Bézier, steps or linear), "
    + "and give no values between 0 and 1 to an animation whose repeats are played as keyframes: one with a repeat delay or in mirror mode.";

interface Numeric {
    value: number;
    unit: string;
}

const numericPattern = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)\s*$/i;

/** A number with an optional unit, the only form whose value is known without computing it. */
function parseNumeric(text: string): Numeric | undefined {
    const [, number, unit] = numericPattern.exec(text) ?? [];
    return number === undefined ? undefined : {value: Number(number), unit: unit!.toLowerCase()};
}

/** A bare number takes the property's default unit. */
function cssTextOf(property: string, value: CSSValue): string {
    if (typeof value === 'string') return value;
    checkNumber(value, `A value of "${property}"`);
    const type = PropertyValueType.of(cssPropertyNameOf(property));
    if (type.defaultUnit === undefined)
        throw new TypeError(`"${property}" doesn't take a bare number, so ${value} needs a unit.`);
    return `${value}${type.defaultUnit}`;
}

/** A kind of numeric value a property may take, told by whether it takes a sample of it. */
interface ValueKind {
    syntax: string;
    unit: string;
}

const valueKinds: readonly ValueKind[] = [
    {syntax: '<number>', unit: ''},
    {syntax: '<length>', unit: 'px'},
    {syntax: '<percentage>', unit: '%'},
    {syntax: '<angle>', unit: 'deg'},
    {syntax: '<time>', unit: 's'}
];

/**
 * The numeric values a property takes, worked out with `CSS.supports`.
 * Values resolve through a registered custom property of the same syntax, a probe: animations and transitions don't touch it, and its computed value is absolute.
 */
class PropertyValueType {
    private static readonly byCSSName = new Map<string, PropertyValueType>();
    private static readonly probesBySyntax = new Map<string, readonly [string, string]>();

    /** The unit a bare number takes: none when the property takes numbers, then px, then deg. */
    readonly defaultUnit: string | undefined;
    private readonly syntax: string;
    /** The values the two probes start from, which differ, so a value the syntax rejects shows as both. */
    private readonly initialValues: readonly [string, string];

    private constructor(private readonly cssName: string) {
        const kinds = valueKinds.filter(({unit}) => CSS.supports(cssName, `1${unit}`));
        if (kinds.length === 0)
            throw new TypeError(`"${cssName}" takes no number, length, percentage, angle or time.`);

        const accepts = (unit: string) => kinds.some(kind => kind.unit === unit);
        this.defaultUnit = ['', 'px', 'deg'].find(accepts);
        const syntaxes = kinds.map(({syntax}) => syntax);
        this.syntax = (accepts('px') && accepts('%')
            ? syntaxes.filter(syntax => syntax !== '<percentage>').map(syntax => syntax === '<length>' ? '<length-percentage>' : syntax)
            : syntaxes
        ).join(' | ');
        this.initialValues = [`0${kinds[0]!.unit}`, `1${kinds[0]!.unit}`];
    }

    static of(cssName: string): PropertyValueType {
        let type = PropertyValueType.byCSSName.get(cssName);
        if (!type) PropertyValueType.byCSSName.set(cssName, type = new PropertyValueType(cssName));
        return type;
    }

    /** The value's computed form on the element. */
    resolve(element: Element, text: string): string {
        const [probe, otherProbe] = this.probes();
        const resolved = computedValueOf(element, probe, text);
        if (resolved === this.initialValues[0] && computedValueOf(element, otherProbe, text) === this.initialValues[1])
            throw new TypeError(`"${text}" doesn't resolve to a single number with a unit for "${this.cssName}".`);
        return resolved;
    }

    private probes(): readonly [string, string] {
        let probes = PropertyValueType.probesBySyntax.get(this.syntax);
        if (probes) return probes;

        const id = PropertyValueType.probesBySyntax.size;
        probes = [`--timesfps-probe-${id}-a`, `--timesfps-probe-${id}-b`];
        probes.forEach((name, index) => {
            try {
                CSS.registerProperty({name, syntax: this.syntax, inherits: false, initialValue: this.initialValues[index]!});
            } catch (error) {
                if (!(error instanceof DOMException && error.name === 'InvalidModificationError')) throw error;
            }
        });
        PropertyValueType.probesBySyntax.set(this.syntax, probes);
        return probes;
    }
}

/** Sets the probe on the element with transitions off, reads its computed value, and puts the element's inline style back. */
function computedValueOf(element: Element, probe: string, text: string): string {
    const {style} = element as Element & ElementCSSInlineStyle;
    if (!style) throw new Error("Values can only be resolved on an element with an inline style.");

    const transition = style.getPropertyValue('transition');
    const transitionPriority = style.getPropertyPriority('transition');
    style.setProperty('transition', 'none', 'important');
    style.setProperty(probe, text);
    const resolved = getComputedStyle(element).getPropertyValue(probe).trim();
    style.removeProperty(probe);
    if (transition) style.setProperty('transition', transition, transitionPriority);
    else style.removeProperty('transition');
    return resolved;
}
