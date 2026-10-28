import {AnimationTiming, type AnimationTimingOptions} from "./animation-timing.ts";
import {type At, checkPositionDescriptor, parsePositionDescriptor, type PositionDescriptor} from "./at.ts";
import {isProduction} from "./utils/environment.ts";

export interface AnimationTimingEntry<Name extends string = string, Names extends string = string> {
    name: Name;
    animation: AnimationTiming;
    position: PositionDescriptor<Names>;
}
export interface SubsequenceTimingEntry<Name extends string = string, Subsequence extends SequenceTiming = SequenceTiming, Names extends string = string> {
    name: Name;
    sequence: Subsequence;
    position: PositionDescriptor<Names>;
}

export type SequenceTimingEntry = AnimationTimingEntry | SubsequenceTimingEntry;

export type SequenceTimingEntries = readonly SequenceTimingEntry[];

type EntryNames<Entries extends SequenceTimingEntries> = Entries[number]['name'];

const SEQUENCE_TIMING_CONSTRUCTION_LICENSE = Symbol("SequenceTimingConstructionLicense");

function createSequenceTimingBuilder(): SequenceTimingBuilder {
    return new (SequenceTimingBuilder as any)([], SEQUENCE_TIMING_CONSTRUCTION_LICENSE);
}
function createSequenceTiming<Entries extends SequenceTimingEntries>(entries: Entries): SequenceTiming<Entries> {
    return new (SequenceTiming as any)(entries, SEQUENCE_TIMING_CONSTRUCTION_LICENSE);
}

/** Builds a sequence timing; every `add` gives a new builder, so branches never share entries. */
export class SequenceTimingBuilder<Entries extends SequenceTimingEntries = []> {
    #entries: Entries;

    private constructor(entries: Entries, license?: typeof SEQUENCE_TIMING_CONSTRUCTION_LICENSE) {
        if (license !== SEQUENCE_TIMING_CONSTRUCTION_LICENSE)
            throw new TypeError(isProduction() ? "Illegal constructor" : `Use ${SequenceTiming.name}.${SequenceTiming.builder.name} to create a ${SequenceTimingBuilder.name}.`);
        this.#entries = entries;
    }

    #addEntry<Entry extends SequenceTimingEntry>(entry: Entry): SequenceTimingBuilder<[...Entries, Entry]> {
        return new SequenceTimingBuilder<[...Entries, Entry]>([...this.#entries, entry], SEQUENCE_TIMING_CONSTRUCTION_LICENSE);
    }

    add<Name extends string>(
        timing: AnimationTiming | AnimationTimingOptions,
        name: Name,
        at?: At<EntryNames<Entries>>
    ): SequenceTimingBuilder<[...Entries, AnimationTimingEntry<Name, EntryNames<Entries>>]>;

    // add<N extends string, A extends TimedTweenTiming<string[]>>(
    //     timing: A,
    //     name: N,
    //     at?: At<keyof SE & string>
    // ): SequenceTimingBuilder<SE & { [_ in N]: TimedTweenTimingEntry<A, keyof SE & string> }>;

    add<Name extends string, Subsequence extends SequenceTiming>(
        sequence: Subsequence,
        name: Name,
        at?: At<EntryNames<Entries>>
    ): SequenceTimingBuilder<[...Entries, SubsequenceTimingEntry<Name, Subsequence, EntryNames<Entries>>]>;

    add<Name extends string>(
        timing: AnimationTiming | AnimationTimingOptions | SequenceTiming,
        name: Name,
        at?: At
    ): SequenceTimingBuilder<[...Entries, SequenceTimingEntry]> {
        const earlierNames = this.#entries.map(entry => entry.name);
        checkNewName(name, earlierNames);
        const position = parsePositionDescriptor(at ?? '>');
        checkPositionDescriptor(position, earlierNames, `Entry "${name}"`);

        return this.#addEntry(timing instanceof SequenceTiming
            ? {name, sequence: timing, position}
            : {name, animation: timing instanceof AnimationTiming ? timing : AnimationTiming.of(timing), position});
    }

    build(): SequenceTiming<Entries> {
        if (this.#entries.length === 0)
            throw new Error("A sequence needs at least one entry.");
        return createSequenceTiming(this.#entries);
    }
}

/** Named timings laid out in time, without targets or values. */
export class SequenceTiming<Entries extends SequenceTimingEntries = SequenceTimingEntries> {
    private constructor(
        readonly entries: Entries,
        license?: typeof SEQUENCE_TIMING_CONSTRUCTION_LICENSE
    ) {
        if (license !== SEQUENCE_TIMING_CONSTRUCTION_LICENSE)
            throw new TypeError(isProduction() ? "Illegal constructor" : `A ${SequenceTiming.name} can only be created using ${SequenceTimingBuilder.name}.`);
    }

    static builder() {
        return createSequenceTimingBuilder();
    }
}

/** A name must be unique among the entries before it, and only contain letters, digits and underscores. */
export function checkNewName(name: string, earlierNames: readonly string[]): void {
    if (earlierNames.includes(name))
        throw new Error(`An entry named "${name}" already exists in this sequence.`);
    if (!/^\w+$/.test(name))
        throw new Error(`The entry name "${name}" can only contain letters, digits and underscores.`);
}
