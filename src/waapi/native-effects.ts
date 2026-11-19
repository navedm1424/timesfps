import {type ByElementAndProperty, mapByElementAndProperty} from "../dom/mapping.ts";
import type {TrackGroup, TrackItem, TrackStop} from "../tracks/track-entries.ts";
import type {Tracks} from "../tracks/tracks.ts";
import type {Seconds} from "../types.ts";
import type {CSSValueResolver} from "./css-values.ts";
import {type MissingValuesUnresolvedEntry, resolveMissingValues} from "./missing-values.ts";
import {endOf, type NativeEffect, NativeEffectBuilder} from "./native-effect-builder.ts";
import {TrackValues} from "./track-values.ts";

/** Each element's properties, each with its native effects in the order they show over each other in. */
export type NativeEffects = ByElementAndProperty<NativeEffect[]>;

/**
 * Turns tracks into native effects, in their tracks' order: the track's entries, their missing values resolved in stacking order,
 * become native effect builders, and each builder builds into its effects.
 */
export class NativeEffectsResolver {
    static resolve(tracks: Tracks, valueResolver: CSSValueResolver): NativeEffects {
        return mapByElementAndProperty(tracks, (track, element, property) => {
            const values = new TrackValues(valueResolver, element, property);
            const unresolved = track.map(entry => new UnresolvedTrackEntry(entry, values));
            const builders = resolveMissingValues(unresolved, () => values.currentValue);
            requireOnlyFirstHoldsBefore(builders);
            return builders.flatMap(builder => builder.build());
        });
    }
}

/** A track entry whose missing values are yet to be resolved. */
class UnresolvedTrackEntry implements MissingValuesUnresolvedEntry<string, NativeEffectBuilder> {
    constructor(private readonly entry: TrackItem | TrackGroup, private readonly values: TrackValues) {}

    /**
     * An item's builder, its missing start taking the value underneath where it starts, and its missing end where it ends;
     * a group's, once its entries' missing values are resolved among them, with `valueUnderneath`'s under them all.
     */
    resolve(valueUnderneath: (time: Seconds) => string): NativeEffectBuilder {
        const {entry, values} = this;
        if (entry.type === 'item')
            return NativeEffectBuilder.ofItem(entry, this.resolvedStopsOf(entry, valueUnderneath), values);

        const entries = resolveMissingValues(entry.entries.map(inner => new UnresolvedTrackEntry(inner, values)), valueUnderneath);
        return NativeEffectBuilder.ofGroup(entry, entries, values);
    }

    /** The item's stops as CSS text: a missing start as the value underneath where it starts, and a missing end where it ends. */
    private resolvedStopsOf(item: TrackItem, valueUnderneath: (time: Seconds) => string): TrackStop<string>[] {
        return item.stops.map(({offset, value}) => {
            if (value !== null) return {offset, value: this.values.textOf(value)};
            return {offset, value: valueUnderneath(offset === 0 ? item.start : endOf(item))};
        });
    }
}

/** Throws for a builder that holds before while another starts before it: WAAPI would hold it over that one. */
function requireOnlyFirstHoldsBefore(builders: readonly NativeEffectBuilder[]): void {
    const firstStart = Math.min(...builders.map(builder => builder.start));
    if (builders.some(builder => builder.holdsBefore && builder.start > firstStart))
        throw new Error("WAAPI holds an effect's start value before it starts only when no effect on its track starts earlier, but one that holds before starts after another. Hold only the first effect before.");
}
