/** An animation leaf's key in a sequence: the names of the entries leading to it, joined by `>`. */
export type EntryPath = string;

/** Every naming rule: what an entry is named without one, and the names of paths, track entries and native animations. */
export interface Naming {
    /** The name at `index` among the names unnamed entries take, in order. */
    unnamedEntryNameOf(index: number): string;
    entryPathOf(parentPath: EntryPath | undefined, name: string): EntryPath;
    /** An animation on its own has no path, and its track entries no name. */
    trackEntryNameOf(path: EntryPath | undefined): string | undefined;
    /** A track entry merged from the animation leaves at `paths`. */
    mergedTrackEntryNameOf(paths: readonly EntryPath[]): string;
    /** A native animation's id, from its track entry's name and its property. */
    animationIdOf(trackEntryName: string | undefined, property: string): string;
}

/** Names are letters, digits and underscores (`checkNewName`), so the `>` of paths and the `+` of merged entries never collide with them. */
export const naming: Naming = {
    /** `a` for 0 to `z` for 25, then `aa`, `ab` and on. */
    unnamedEntryNameOf(index) {
        let name = '';
        for (let remaining = index + 1; remaining > 0; remaining = Math.floor((remaining - 1) / 26))
            name = String.fromCharCode('a'.charCodeAt(0) + (remaining - 1) % 26) + name;
        return name;
    },
    entryPathOf: (parentPath, name) => parentPath ? `${parentPath}>${name}` : name,
    trackEntryNameOf: path => path,
    mergedTrackEntryNameOf: paths => paths.join('+'),
    animationIdOf: (trackEntryName, property) => trackEntryName ? `${trackEntryName}:${property}` : property
};
