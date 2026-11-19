import {type ByElementAndProperty, mapByElementAndProperty} from "../dom/mapping.ts";
import {timeAtOffset, type TrackGroup, type TrackItem} from "../tracks/track-entries.ts";
import type {Tracks} from "../tracks/tracks.ts";
import type {Seconds} from "../types.ts";
import {CurrentValueProvider} from "./css-values.ts";
import {type MissingValuesUnresolvedEntry, resolveMissingValues} from "./missing-values.ts";
import {type NativeEffect, NativeEffectBuilder} from "./native-effect-builder.ts";
import {NativeEffectScale, type ScaleStop} from "./native-effect-scale.ts";
import {ResolvedTrackGroup, ResolvedTrackItem} from "./resolved-track-entries.ts";

/** Each element's properties, each with its native effects in the order they show over each other in. */
export type NativeEffects = ByElementAndProperty<NativeEffect[]>;

/**
 * Turns tracks into native effects, in their tracks' order: the track's entries, their missing values resolved in stacking order
 * over the property's current value, each build into their effects.
 */
export class NativeEffectsResolver {
    static resolve(tracks: Tracks): NativeEffects {
        return mapByElementAndProperty(tracks, (track, element, property) => {
            const currentValues = new CurrentValueProvider(element);
            const nativeEffectScaleFactory = (stops: readonly ScaleStop[]) => new NativeEffectScale(element, property, stops);
            const unresolved = track.map(entry => new UnresolvedTrackEntry(entry, nativeEffectScaleFactory));
            const entries = resolveMissingValues(unresolved, () => currentValues.get(property));
            requireOnlyFirstHoldsBefore(entries);
            return entries.flatMap(entry => new NativeEffectBuilder(entry).build());
        });
    }
}

type ResolvedTrackEntry = ResolvedTrackItem | ResolvedTrackGroup;

/** A track entry whose missing values are yet to be resolved; an item's values become a scale through `nativeEffectScaleFactory`. */
class UnresolvedTrackEntry implements MissingValuesUnresolvedEntry<string, ResolvedTrackEntry> {
    constructor(
        private readonly entry: TrackItem | TrackGroup,
        private readonly nativeEffectScaleFactory: (stops: readonly ScaleStop[]) => NativeEffectScale
    ) {}

    /**
     * An item, its missing start taking the value underneath where it starts, and its missing end where it ends;
     * a group, once its entries' missing values are resolved among them, with `valueUnderneath`'s under them all.
     */
    resolve(valueUnderneath: (time: Seconds) => string): ResolvedTrackEntry {
        const {entry, nativeEffectScaleFactory} = this;
        if (entry.type === 'item')
            return ResolvedTrackItem.of(entry, nativeEffectScaleFactory(this.resolvedStopsOf(valueUnderneath)));

        const entries = resolveMissingValues(entry.entries.map(inner => new UnresolvedTrackEntry(inner, nativeEffectScaleFactory)), valueUnderneath);
        return ResolvedTrackGroup.of(entry, entries);
    }

    /** The item's stops, each missing one taking the value underneath at its time. */
    private resolvedStopsOf(valueUnderneath: (time: Seconds) => string): ScaleStop[] {
        const item = this.entry;
        if (item.type !== 'item')
            throw new Error("Only a track item has stops to resolve, but this entry is a group. Resolve the stops of the items in it.");
        return item.stops.map(({offset, value}) => ({offset, value: value ?? valueUnderneath(timeAtOffset(item, offset))}));
    }
}

/** Throws for an entry that holds before while another starts before it: WAAPI would hold it over that one. */
function requireOnlyFirstHoldsBefore(entries: readonly ResolvedTrackEntry[]): void {
    const startOf = (entry: ResolvedTrackEntry) => entry.plays(0, 0)[0]!.start;
    const firstStart = Math.min(...entries.map(startOf));
    if (entries.some(entry => entry.holdsBefore && startOf(entry) > firstStart))
        throw new Error("WAAPI holds an effect's start value before it starts only when no effect on its track starts earlier, but one that holds before starts after another. Hold only the first effect before.");
}
