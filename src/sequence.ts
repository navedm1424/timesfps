import type {AnimationTiming, AnimationTimingOptions} from "./animation-timing.ts";
import {AnimationDefinition} from "./animation.ts";
import type {At} from "./at.ts";
import type {AnimationMapping, AnimationValues, SequenceMapping, Target} from "./dom/mapping.ts";
import {
    entryPathOf,
    type EntryPath,
    SequenceTiming,
    type SequenceTimingBuilder,
    type SequenceTimingEntries
} from "./sequence-timing.ts";
import {isProduction} from "./utils/environment.ts";

/** Where an entry goes in a sequence: the name later positions refer to it by, and when it starts. */
export interface EntryPlacementOptions<N extends string, Names extends string> {
    name?: N;
    at?: At<Names>;
}

export type Definition = AnimationDefinition | SequenceDefinition;

export interface AnimationDefinitionEntry<Name extends string = string> {
    name: Name;
    animation: AnimationDefinition;
}
export interface SubsequenceDefinitionEntry<Name extends string = string> {
    name: Name;
    sequence: SequenceDefinition;
}

export type SequenceDefinitionEntry = AnimationDefinitionEntry | SubsequenceDefinitionEntry;

/** A sequence definition's entries, in the order of its timing's entries: an animation definition for each animation timing, and a sequence definition for each nested sequence timing. */
export type SequenceDefinitionEntries = readonly SequenceDefinitionEntry[];

const SEQUENCE_DEFINITION_CONSTRUCTION_LICENSE = Symbol("SequenceDefinitionConstructionLicense");

function createSequenceDefinitionBuilder(): SequenceDefinitionBuilder {
    return new (SequenceDefinitionBuilder as any)([], SEQUENCE_DEFINITION_CONSTRUCTION_LICENSE);
}
function createSequenceDefinition(entries: SequenceDefinitionEntries, timing: SequenceTiming): SequenceDefinition {
    return new (SequenceDefinition as any)(entries, timing, SEQUENCE_DEFINITION_CONSTRUCTION_LICENSE);
}

/** A sequence built entry by entry, or a sequence timing given with its mapping. */
export function sequence(): SequenceDefinitionBuilder;
export function sequence<Timing extends SequenceTiming>(timing: Timing, mapping: SequenceMapping<Timing>): SequenceDefinition;
export function sequence(timing?: SequenceTiming, mapping?: SequenceMapping): SequenceDefinitionBuilder | SequenceDefinition {
    if (!timing) return createSequenceDefinitionBuilder();
    return SequenceDefinition.of(timing, mapping!);
}

/** Timings laid out in time and bound to targets and values, ready to play any number of times. */
export class SequenceDefinition {
    /** @internal */
    readonly entries: SequenceDefinitionEntries;
    /** @internal */
    readonly timing: SequenceTiming;

    private constructor(entries: SequenceDefinitionEntries, timing: SequenceTiming, license?: typeof SEQUENCE_DEFINITION_CONSTRUCTION_LICENSE) {
        if (license !== SEQUENCE_DEFINITION_CONSTRUCTION_LICENSE)
            throw new TypeError(isProduction() ? "Illegal constructor" : `A ${SequenceDefinition.name} can only be created using ${SequenceDefinitionBuilder.name} or ${SequenceDefinition.name}.${SequenceDefinition.of.name}.`);
        this.entries = entries;
        this.timing = timing;
    }

    /** A sequence timing bound to its mapping; every entry must be mapped, and every animation's values must take one of the forms. */
    static of<Timing extends SequenceTiming>(timing: Timing, mapping: SequenceMapping<Timing>): SequenceDefinition {
        return createSequenceDefinition(definitionEntriesOf(timing, mapping), timing);
    }
}

/** An entry as it's added, before the unnamed ones get their names. */
interface PendingEntry {
    name: string | undefined;
    at: At | undefined;
    definition: Definition;
}

type InlineEntryArgs = [
    target: Target,
    values: AnimationValues,
    timing: AnimationTiming | AnimationTimingOptions,
    placement?: EntryPlacementOptions<string, string>
];
type DefinitionEntryArgs = [definition: Definition, placement?: EntryPlacementOptions<string, string>];

/** Builds a sequence definition; every `add` gives a new builder, and positions can refer to the entries named before them. */
export class SequenceDefinitionBuilder<Names extends string = never> {
    private constructor(private readonly entries: readonly PendingEntry[], license?: typeof SEQUENCE_DEFINITION_CONSTRUCTION_LICENSE) {
        if (license !== SEQUENCE_DEFINITION_CONSTRUCTION_LICENSE)
            throw new TypeError(isProduction() ? "Illegal constructor" : `Use ${sequence.name} to create a ${SequenceDefinitionBuilder.name}.`);
    }

    add<N extends string = never>(
        target: Target,
        values: AnimationValues,
        timing: AnimationTiming | AnimationTimingOptions,
        placement?: EntryPlacementOptions<N, Names>
    ): SequenceDefinitionBuilder<Names | N>;
    add<N extends string = never>(
        definition: Definition,
        placement?: EntryPlacementOptions<N, Names>
    ): SequenceDefinitionBuilder<Names | N>;
    add(...args: InlineEntryArgs | DefinitionEntryArgs): SequenceDefinitionBuilder<string> {
        const [definition, {name, at}] = this.#isDefinitionEntry(args) ? [args[0], args[1] ?? {}] : this.#inlineEntryOf(args);
        return new SequenceDefinitionBuilder([...this.entries, {name, at, definition}], SEQUENCE_DEFINITION_CONSTRUCTION_LICENSE);
    }

    #isDefinitionEntry(args: InlineEntryArgs | DefinitionEntryArgs): args is DefinitionEntryArgs {
        return args[0] instanceof AnimationDefinition || args[0] instanceof SequenceDefinition;
    }
    /** The inline entry's animation, and its placement. */
    #inlineEntryOf([target, values, timing, placement = {}]: InlineEntryArgs): [AnimationDefinition, EntryPlacementOptions<string, string>] {
        return [new AnimationDefinition(target, values, timing), placement];
    }

    /** Names the unnamed entries in order, as `a` to `z`, then `aa` and on, skipping the names given. */
    build(): SequenceDefinition {
        const givenNames = new Set(this.givenNames);
        let builder: SequenceTimingBuilder<SequenceTimingEntries> = SequenceTiming.builder();
        const entries: SequenceDefinitionEntry[] = [];
        let ordinal = 0;
        const nextUnnamedName = () => {
            let name: string;
            do name = alphabeticNameOf(ordinal++);
            while (givenNames.has(name));
            return name;
        };
        for (const {name: givenName, at, definition} of this.entries) {
            const name = givenName ?? nextUnnamedName();
            if (definition instanceof SequenceDefinition) {
                builder = builder.add(definition.timing, name, at);
                entries.push({name, sequence: definition});
            } else {
                builder = builder.add(definition.timing, name, at);
                entries.push({name, animation: definition});
            }
        }
        return createSequenceDefinition(entries, builder.build());
    }

    private get givenNames(): string[] {
        return this.entries.flatMap(({name}) => name === undefined ? [] : [name]);
    }
}

/** The definitions of a sequence timing's entries, made from its mapping, which must map every entry. */
function definitionEntriesOf<Timing extends SequenceTiming>(timing: Timing, mapping?: SequenceMapping<Timing>, path?: EntryPath): SequenceDefinitionEntries {
    if (!mapping) throw new TypeError(path ? `No mapping present for "${path}".` : "No mapping present.");
    const entries: SequenceDefinitionEntry[] = [];
    for (const entry of timing.entries) {
        const entryPath = entryPathOf(path, entry.name);
        const entryMapping = mapping[entry.name];
        if (!entryMapping) throw new TypeError(`No mapping present for "${entryPath}".`);
        if ('sequence' in entry) {
            const subsequenceEntries = definitionEntriesOf(entry.sequence, entryMapping as SequenceMapping, entryPath);
            entries.push({name: entry.name, sequence: createSequenceDefinition(subsequenceEntries, entry.sequence)});
            continue;
        }
        if (!Array.isArray(entryMapping)) throw new TypeError(`The mapping of "${entryPath}" needs a target and values.`);
        const [target, values] = entryMapping as AnimationMapping;
        if (target === undefined || values === undefined)
            throw new TypeError(`The mapping of "${entryPath}" needs a target and values.`);
        entries.push({name: entry.name, animation: new AnimationDefinition(target, values, entry.animation)});
    }
    return entries;
}

/** `a` for 0 to `z` for 25, then `aa`, `ab` and on. */
function alphabeticNameOf(index: number): string {
    let name = '';
    for (let remaining = index + 1; remaining > 0; remaining = Math.floor((remaining - 1) / 26))
        name = String.fromCharCode('a'.charCodeAt(0) + (remaining - 1) % 26) + name;
    return name;
}
