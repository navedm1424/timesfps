# TimesFPS: Implementation Spec

This document is for people working on the library. It covers what the library is for, its API surface, how the code is laid out, how a definition becomes running WAAPI animations, and why things are the way they are.

The library lives in `src/`. Resolution tools that any adapter may use or not are in `src/resolution/`, the WAAPI adapter is in `src/waapi/`, and the tests are in `tests/`.

> **Status.** The code implements §1–§3, except ending on the value underneath: a missing 1 takes the last given value for now (§3.4).

## 1. Purpose

### 1.1 What it is

TimesFPS is a library for designing animations, meaning their timing, motion and choreography, in a form that's easy to write and portable across conventions and engines.

- **Timing is its own model.** A timing says how a change from 0 to 1 unfolds in time. It never names targets, properties or values, so one timing can be bound to any elements and values, and later run on any engine.
- **Definitions bind timing to targets and values.** A definition has no playback state. An animator plays it: that creates the running animations and returns their controls.

### 1.2 Why it exists

Native animations (WAAPI and CSS) run without JavaScript per frame, but they leave the hard parts of motion design to you:

| Native animations | TimesFPS |
|---|---|
| No way to design a sequence, and no ergonomic API for choreographing complex ones | `sequence()`: named entries, positions relative to any earlier entry, shares of entries, and nesting |
| No fluid spring motion. `linear()` samples a spring into straight segments, which shows as facets with few points and grows long with many | Springs fitted as cubic Bézier keyframes that follow the closed-form motion within `PRECISION` (0.001) |
| No interruptibility, and a spring that can't be interrupted loses most of its point | Retargeting from the current value and velocity (`retarget`: declared, not implemented yet) |
| No repeat delays | `repeatDelay`, on animations |
| Alternating, but no mirroring | `repeatMode: 'mirror'`: values swap, easing runs forwards |

### 1.3 Where it's going

- **Adapters for Motion and GSAP.** The same timing and choreography run on either library by changing one parameter, possibly per entry.
- **A readonly sequence tree,** so callers and adapters can read particular entries.
- **Motion-style React components,** so animations can be declared on the component. 
- **Other engines,** later.
- **The focus now** is DOM-based animations played with WAAPI.

### 1.4 Principles

- **Open to extension, closed to modification.** New transitions, engines and adapters are added beside what exists, without changing it:
    - each transition kind has a required key no other kind has, so a new kind never changes how existing ones are told apart (§2.2);
    - the timing model never refers to targets, values or engines.
- **Mistakes throw where they're made.** Factories, constructors and builders validate and clamp, so an invalid timing, position or name throws at the call that wrote it.
- **Definitions are values.** Timings, definitions and builders are immutable: every `add` returns a new builder.

## 2. The Timing Model

Everything here is value-free: it describes how a change from 0 to 1 unfolds in time.

### 2.1 Units

| Type | Meaning |
|---|---|
| `Seconds` | Time. Every public time is in seconds. The WAAPI adapter converts to milliseconds only when it calls `element.animate()`. |
| `Progress` | A position on the 0→1 change axis. A spring or an overshooting cubic Bézier can pass beyond it. |

- **The definition only knows that something goes from 0 to 1.** The values decide what 0, 0.5 and 1 mean.
- **`PRECISION`** (0.001, `src/constants.ts`) is how close two progresses must be to count as the same. It's the rest threshold of every spring without its own `restDelta`, and the precision every fitted curve keeps.

### 2.2 Transition options

Transition options shape one play: its duration, and how its progress moves (`src/transition.ts`).

```ts
type TransitionOptions = EasedTransitionOptions | SpringTransitionOptions;
type SpringTransitionOptions =
    | DurationSpringTransitionOptions
    | VisualSpringTransitionOptions
    | PhysicalSpringTransitionOptions;
```

| Kind | Fields | Told apart by |
|---|---|---|
| Eased | `duration: Seconds`, `easing?: EasingSpecifier` | the fallback: a `duration` without `bounce` |
| Duration spring | `duration: Seconds`, `bounce: number`, `velocity?: number` | `bounce` with `duration` |
| Visual spring | `visualDuration: Seconds`, `bounce: number`, `velocity?: number` | `visualDuration` |
| Physical spring | `stiffness`, `damping`, `mass?`, `velocity?`, `restDelta?: Progress` | `stiffness` and `damping` |

**Telling kinds apart.**
- There's no `type` field. Kinds are told apart by their keys.
- Each kind declares the other kinds' keys as `?: never`, so a literal that mixes kinds is a type error. TypeScript's excess property check wouldn't catch it on its own: for a union without a discriminant, it only checks that each property exists in some member.
- Code narrows with `!== undefined` on a kind's key. `in` doesn't narrow when every member declares the key.
- At runtime, the kind is: physical with `stiffness` or `damping`, visual with `visualDuration`, the duration spring with `bounce`, and eased otherwise. A key from any other kind throws, for JavaScript callers and casts.
- **Extension rule:** a new kind needs a required key no other kind has. Eased stays the fallback, so `bounce` must stay required.
- There are no `eased()` or `spring()` factories: the fields are clearer written out.

**Validation** (`checkTransitionOptions`, on every way a timing is made). A missing required key throws a `TypeError` through `requireNumber` or `requireProperty` (`src/utils/validation.ts`), and a number out of range a `RangeError`:

| Field | Rule |
|---|---|
| Eased `duration` | A finite number, at least 0. 0 jumps straight to the end values. |
| Spring `duration`, `visualDuration`, `stiffness`, `damping`, `mass` | A finite number above 0. |
| `bounce` | Required on both springs that take it: a missing one throws a `TypeError`. Strictly between -1 and 1. |
| `velocity` | A finite number. |
| `restDelta` | Strictly between 0 and 1. |
| `easing` | As in §2.3, through `checkEasingSpecifier`. |

**Resolution** (`resolveTransition`) gives a `TransitionDescriptor`, `{duration, easing}`: the play's duration and its `Easing`, which depends on the kind. A spring's comes from `transitionDescriptorOf(spring, restDelta)`, which runs it until it rests. The plan calls it as a definition plays (§5.3), not the timing. Each transition is resolved once and the result kept, so every play of a timing shares one easing, and the spring fits cached on it. The spring math behind a spring's easing belongs to the springs themselves (§4):
- **Eased:** the duration as given, and `resolveEasing(easing)`, or `linear` without one.
- **Springs:** the duration below, and a `SpringEasing` over it:

| Kind | Natural frequency ω₀ | Damping ratio ζ | Duration |
|---|---|---|---|
| Physical | √(k / m) | c / (2√(k·m)) | until it rests within `restDelta ?? PRECISION` |
| Visual | 2π / `visualDuration` | from `bounce` | until it rests within `PRECISION` |
| Duration | solved so it rests within `PRECISION` exactly at `duration` | from `bounce` | `duration` as given |

- **`bounce` to ζ,** as Apple's springs do: `bounce ≥ 0 ? 1 − bounce : 1 / (1 + bounce)`.
- **Spring quantities are in progress units.** `velocity` is progress per second, and `restDelta` is a `Progress`, defaulting to `PRECISION`. This is sound because a spring's motion is linear in its distance: a spring from 0 to 1 is a scaled copy of the same spring between any two values.

### 2.3 Easings

**Specifiers** (`src/easing-specifier.ts`). The params types, `CubicBezierEasingParams`, `StepsEasingParams` and `StepPosition`, are the easing classes' own and live in `src/easing.ts`; the specifier module uses them:

| Form | Type | Meaning |
|---|---|---|
| Preset | `'linear' \| 'ease' \| 'easeIn' \| 'easeOut' \| 'easeInOut'` | CSS's curves, below |
| Cubic Bézier | `CubicBezierEasingParams = readonly [x1, y1, x2, y2]` | As CSS `cubic-bezier()`. `x1` and `x2` must be within 0–1. |
| Steps | `StepsEasingParams = readonly [count, position?: StepPosition]` | As CSS `steps()`. `StepPosition` is `'jumpStart' \| 'jumpEnd' \| 'jumpNone' \| 'jumpBoth'`, defaulting to `'jumpEnd'`. `count` is a whole number of at least 1, or 2 for `'jumpNone'`. |

| Preset | Curve |
|---|---|
| `ease` | `(0.25, 0.1, 0.25, 1)` |
| `easeIn` | `(0.42, 0, 1, 1)` |
| `easeOut` | `(0, 0, 0.58, 1)` |
| `easeInOut` | `(0.42, 0, 0.58, 1)` |

- **`cubicBezier(x1, y1, x2, y2)`** and **`steps(count, position?)`** return the same tuples, `[count]` or `[count, position]`. Helpers exist here because these params are positional tuples. Transitions have named keys, so they need none.
- **`checkEasingSpecifier`** throws unless the specifier is a preset (a `TypeError` otherwise), or params of the right length for one of the classes, whose own static `check` it then calls: `CubicBezierEasing.check` (finite control points, `x1` and `x2` within 0–1) and `StepsEasing.check` (a known position, and the count above). The class constructors call the same `check`. Transitions and staggers check their easing as they're made.
- **`resolveEasing`** gives the `Easing`. Presets are shared instances, and `linear` is exported for the code that needs the linear easing itself.

**Easings** (`src/easing.ts`). An `Easing` is pure math over its input time, from 0 to 1, limited to a **window** from `windowStart` to `windowEnd`. It isn't exported: nothing public takes or gives one.

| Member | Meaning |
|---|---|
| `progressAt(offset)` | The progress at an offset. Offsets are fractions of the window, and the progress isn't rescaled to it: a window from 0.25 to 0.75 of `linear` gives a progress from 0.25 to 0.75. |
| `startProgress`, `endProgress` | The progress the window starts from and ends at, before or after any jump right at an edge. They only differ from `progressAt(0)` and `progressAt(1)` for steps: CSS steps are right-continuous, so a jump-start easing already outputs 1/n at time 0, but it starts *from* 0. |
| `turningOffsets()` | The offsets strictly inside the window where the progress turns back, in order. |
| `offsetsAt(progress)` | The offsets in the window where the progress reaches `progress`, in order, clamped to 0–1. |
| `windowed(start, end)` | The part of the window between two offsets, running backwards when `end` comes first. |
| `reversed()` | The window run backwards: `windowEnd` and `windowStart` swapped. |
| `isWhole` | Whether the window is the whole easing, forwards. |

- **A window runs backwards** when `windowEnd` comes before `windowStart`.
- **Splitting is always done by cutting windows,** never by building new curves.
- Offsets found by solving count as inside the window within 10⁻⁹.

| Class | Progress at input *u* | Turns back at | Also |
|---|---|---|---|
| `LinearEasing` | *u* | never | `linear` is the shared instance |
| `CubicBezierEasing` | y at the curve parameter where x = *u* | x at y's turning parameters | `params`, `curve` (`src/cubic-bezier.ts`), static `check` |
| `StepsEasing` | `clamp(floor(u·count) + startJump, 0, jumps) / jumps` | never | `params`, `jumpOffsets()`, the offsets strictly inside the window where it jumps, static `check` |
| `SpringEasing` | the spring's position at *u*·`duration`, plus the closing gap | turning times / `duration` | `spring`, `duration`, `turningTimes`, `progressAtTime`, `slopeAtTime` |

- **Steps:** `jumps` is `count` for `jumpStart` and `jumpEnd`, `count − 1` for `jumpNone`, and `count + 1` for `jumpBoth`. `startJump` is 1 for `jumpStart` and `jumpBoth`, and 0 otherwise.
- **Springs:** a `SpringEasing` is the spring's closed-form motion over its duration. It closes the gap left at the end, 1 − position(`duration`), evenly from its last turning time to its duration, so it ends at exactly 1 without a jump.

### 2.4 Playback options

```ts
type RepeatMode = 'loop' | 'reverse' | 'mirror';

interface RepeatOptions {
    repeat?: number;            // plays after the first
    repeatDelay?: Seconds;      // between plays, never after the last
    repeatMode?: RepeatMode;
}

interface PlaybackOptions extends RepeatOptions {
    delay?: Seconds | Stagger;  // before the first play; not repeated
}

interface PlaybackDescriptor extends RepeatOptions {
    delay?: Seconds | Stagger;  // a stagger checked by checkedStaggerOf
}
```

- **Animations take them.** Sequences have no playback options (§8).
- **What a timing keeps** is a `PlaybackDescriptor`, in its `playback` field: the options clamped, with a stagger wrapped by `checkedStaggerOf` (§2.5).

| Option | Default | Rule |
|---|---|---|
| `delay` | 0 | A finite number, or a stagger. Negative becomes 0. |
| `repeat` | 0 | A number, and may be `Infinity`. Negative becomes 0, and fractions round down. |
| `repeatDelay` | 0 | A finite number. Negative becomes 0. |
| `repeatMode` | `'loop'` | One of the modes below. Any other throws a `TypeError`. |

| Mode | Every other play |
|---|---|
| `loop` | Runs forwards again. |
| `reverse` | Runs backwards in time, so its easing runs backwards too. |
| `mirror` | Flips the progress (`1 − progress`) and keeps the easing running forwards. This usually suits springs, because a spring played backwards starts wobbly and ends calm. |

- **`Infinity`** is a valid `repeat`.
- **Checks and clamping** are `checkPlaybackOptions`, `clampedDelay` and `clampedRepeats` (`src/playback-options.ts`). `NaN` and infinite times throw through `checkNumber` (`src/utils/validation.ts`).
- **Collecting the options.** `AnimationTiming`'s constructor checks the options with `checkPlaybackOptions`, then keeps `playbackDescriptorOf(options)`, which clamps them and wraps a stagger `delay` with `checkedStaggerOf`.

### 2.5 Staggers

```ts
interface Stagger {
    (index: number, total: number): Seconds;
    readonly from?: StaggerOrigin;          // set by stagger()
}

type StaggerSpacing = {step: Seconds; spread?: never} | {spread: Seconds; step?: never};
type StaggerOrigin = 'first' | 'last' | 'center' | number;

interface StaggerOptions {
    startDelay?: Seconds;                   // 0 by default
    from?: StaggerOrigin;
    easing?: EasingSpecifier;
}

function stagger(step: Seconds, options?: StaggerOptions): Stagger;
function stagger(options: StaggerSpacing & StaggerOptions): Stagger;
```

A stagger is a `delay` given as a function of each element's index. `Stagger` is a playback option (`src/playback-options.ts`), and `stagger` is the utility that makes one (`src/stagger.ts`). It's a timing decision, so it belongs in the timing. Only playing says how many elements there are, so delays are resolved at adaptation.

**`stagger()` keeps its origin** on the function it returns, as `from` (`'first'` when none is given).

**`checkedStaggerOf(stagger)`** (`src/playback-options.ts`) wraps a stagger so each delay that's `NaN` or infinite throws (`The staggered delay of element <index> …`), and a negative one becomes 0. The wrapper keeps the stagger's `from`. Timings keep their stagger wrapped this way, in their `PlaybackDescriptor` (§2.4). The plan calls it with each element's index and the element count.

| Term | Value |
|---|---|
| origin | `first`: 0. `last`: total − 1. `center`: (total − 1) / 2. A number: itself. |
| distance | \|index − origin\| |
| farthest | max(origin, total − 1 − origin) |

**One formula.** The delay, before `startDelay` is added, is

> easing(distance / farthest) × span

where `easing` is `linear` unless one is given, and the span is `spread`, or farthest × `step`. So:

| Options | Delay, before `startDelay` is added |
|---|---|
| `step` | distance × `step` |
| `step`, `easing` | easing(distance / farthest) × farthest × `step` |
| `spread` | distance / farthest × `spread` |
| `spread`, `easing` | easing(distance / farthest) × `spread` |

- **A number** as the first argument is the `step`, so `stagger(0.05, {from: 'center'})` is `stagger({step: 0.05, from: 'center'})`. `spread` only goes by name.
- **`startDelay`** is the origin's delay, added to every element's.
- With `spread`, the farthest element waits exactly `startDelay + spread`. With `from: 'center'`, both edges do.
- A farthest distance of 0 gives `startDelay`.
- **Validation:** exactly one of `step` and `spread`, and `step`, `spread`, `startDelay` and a number `from` must be finite. The easing goes through `checkEasingSpecifier`.
- **The names** say what each one is: `step` is the time between neighbours, `spread` the time the delays spread over. GSAP calls them `each` and `amount`, and Motion calls `startDelay` the same.
- **Resolved delays:** negative ones become 0, and NaN or infinite ones throw, through `checkedStaggerOf`.
- **Fractional indices:** the formula takes them as they are, so a position between two elements gets the delay between theirs.
- **Any `Stagger` function** works where a stagger does.

### 2.6 Animation timing

```ts
class AnimationTiming {
    private constructor(transition: TransitionOptions, options?: PlaybackOptions);
    static of(timing: AnimationTimingOptions): AnimationTiming;
    static of(transition: TransitionOptions, options?: PlaybackOptions): AnimationTiming;

    readonly transition: TransitionOptions;
    readonly playback: PlaybackDescriptor;  // clamped, with a stagger wrapped
}

type AnimationTimingOptions = TransitionOptions & PlaybackOptions;
```

- **One play through the transition,** with its delay and repeats (`src/animation-timing.ts`).
- **`of` is the only way to make one.** The constructor is private, and validates the transition and options, and keeps the options as a `PlaybackDescriptor` (§2.4).
- **A timing validates and stores.** It keeps the transition as given and never resolves it: its duration and easing come from `resolveTransition` (§2.2).
- **`AnimationTimingOptions`** is a transition with the playback options spread into it. `of` splits its first argument by key into the transition options and the playback options (`delay`, `repeat`, `repeatDelay`, `repeatMode`), and the `options` given override the ones split out. The two key sets never overlap, so a transition on its own splits into itself, and both overloads share one implementation.
- **Wherever a timing is taken,** an `AnimationTiming` is used as it is, and `AnimationTimingOptions` go through `of` there.
- **Timings have no name.** They get one when they're placed in a sequence, so the same timing can be placed many times.
- **There's no superclass.** Each timing class validates its own options.
- **`TimedTweenTiming`** is pending and internal (not exported from `src/animation-timing.ts`): tweens that run one after another, each with its own transition, delay and finite repeats. Sequences can't hold it yet, and nothing plays it.

### 2.7 Sequence timing

```ts
class SequenceTiming<Entries extends SequenceTimingEntries = SequenceTimingEntries> {
    static builder(): SequenceTimingBuilder;

    readonly entries: Entries;
}

class SequenceTimingBuilder<Entries extends SequenceTimingEntries = []> {
    add<Name extends string>(timing: AnimationTiming | AnimationTimingOptions, name: Name, at?: At<EntryNames<Entries>>)
        : SequenceTimingBuilder<[...Entries, AnimationTimingEntry<Name, EntryNames<Entries>>]>;
    add<Name extends string, Subsequence extends SequenceTiming>(sequence: Subsequence, name: Name, at?: At<EntryNames<Entries>>)
        : SequenceTimingBuilder<[...Entries, SubsequenceTimingEntry<Name, Subsequence, EntryNames<Entries>>]>;
    build(): SequenceTiming<Entries>;
}

interface AnimationTimingEntry<Name, Names> { name: Name; animation: AnimationTiming; position: PositionDescriptor<Names> }
interface SubsequenceTimingEntry<Name, Subsequence, Names> { name: Name; sequence: Subsequence; position: PositionDescriptor<Names> }
type SequenceTimingEntries = readonly (AnimationTimingEntry | SubsequenceTimingEntry)[];
type EntryNames<Entries> = Entries[number]['name'];
```

A sequence timing lays named timings out in time, without targets or values (`src/sequence-timing.ts`).

- **Names** are required, because a mapping refers to entries by name (§3.5). They're unique within their sequence, and can only contain letters, digits and underscores. So they can't contain `>`, and entry paths can't collide.
- **The builder is the only validator.** `add` checks the name (`checkNewName`), parses the position and checks it against the names so far (`checkPositionDescriptor`, `src/at.ts`), and makes `AnimationTimingOptions` into an `AnimationTiming`, so all of these throw at the `add` that wrote them. `build` throws for a sequence without entries.
- **Private constructors.** `SequenceTiming` and `SequenceTimingBuilder` have private constructors that throw a `TypeError` unless they're passed a license symbol private to `src/sequence-timing.ts`. The message names the classes, and says to use `SequenceTiming.builder` or the builder. In a production build (`isProduction()`, §4) it's `Illegal constructor` instead, because minifying renames the classes. `SequenceTiming.builder()` is the only way in, so a `SequenceTiming` is always one a builder checked, and its constructor checks nothing: the builder has the license, and does all of the collecting and checking for it.
- **Builders are immutable.** `add` returns a new builder with its own copy of the entries, so branches never share entries.
- **Entries** are one ordered array, `entries`. Each is `{name, animation, position}` (`AnimationTimingEntry`) or `{name, sequence, position}` (`SubsequenceTimingEntry`), where `position` is the parsed `PositionDescriptor`. The builder's and the timing's type parameter is the entries' tuple type, each entry with its name as a literal type, so a mapping's type can mirror the tree (§3.5), and `At` takes the names so far.
- **Entry paths** (`EntryPath`, `entryPathOf`, here) are the names leading to an entry, joined by `>`. The definitions and the adapter name entries by them.
- **Nesting.** A subsequence is one unit on the outer timeline. Its entries' positions only place them within it.

#### 2.7.1 Positions

`at` is a position written as an expression. `parsePositionDescriptor` parses it into a `PositionDescriptor`, and `resolvePosition` turns that into a time. All three live in `src/at.ts`.

```
at              = Seconds | expression
expression      = point [referenceOffset] [selfOffset] [secondsOffset]
point           = '' | '>' | '<' | name | name '>' | name '<' | '<<' | '>>'
referenceOffset = sign amount '%'
selfOffset      = sign '=' amount '%'
secondsOffset   = sign amount
sign            = '+' | '-'
```

| Point | Reference point | Reference duration |
|---|---|---|
| `''`, `'>'` | the previous entry's end | the previous entry's duration |
| `'<'` | the previous entry's start | the previous entry's duration |
| `name`, `name>` | that entry's end | that entry's duration |
| `name<` | that entry's start | that entry's duration |
| `'<<'` | the start of the sequence, 0 | from 0 to the latest end so far |
| `'>>'` | the latest end so far | from 0 to the latest end so far |

| Offset, in order | Adds |
|---|---|
| `+n%`, `-n%` | a fraction of the reference duration |
| `+=n%`, `-=n%` | a fraction of the inserted entry's duration |
| `+n`, `-n` | seconds |

- **A number** `n` is `'<<+n'`.
- **An omitted `at`** is `'>'`.
- **One offset of each kind, in that order.** It follows how a position is thought out: the point on the reference, which part of the entry sits on it, then a nudge. `'<+50%-=50%+0.1'` centres the entry on the previous entry's midpoint, 0.1 seconds later. Two offsets of one kind would only need adding up, so the bound of three explains itself, and every position has one spelling.

**The descriptor.** Every position is a reference point, a reference duration and an offset:

```ts
type PositionReference<Name> =
    | {kind: 'previousEntry'}
    | {kind: 'entry'; name: Name}
    | {kind: 'everythingSoFar'};            // from 0 to the latest end so far

interface PositionDescriptor<Name> {
    reference: PositionReference<Name>;     // gives the reference point and the reference duration
    anchor: 'start' | 'end';                // which end of the reference is the point
    offset: PositionOffset;                 // one total offset, as one amount of each kind
}

interface PositionOffset {
    seconds: Seconds;
    referenceFraction: number;
    selfFraction: number;
}
```

- Each offset fills its kind's field, and a missing one is 0. `25%` is a fraction of 0.25.
- `'<<'` is `everythingSoFar` at its `start`, and `'>>'` at its `end`.

**Resolving.** `resolvePosition(descriptor, entrySpans, selfDuration)`:
- `entrySpans` maps the earlier entries' names to `EntrySpan`s, `{start, duration}`, in order, so its last entry is the previous one. With none, the previous entry is `{start: 0, duration: 0}`.
- Everything so far is `{start: 0, duration: latest end}`, where the latest end is the largest `start + duration`, or 0.
- The result is the reference point, plus the seconds, plus `referenceFraction` × the reference duration, plus `selfFraction` × `selfDuration`.
- It can be negative. The timings resolver (§5.3) clamps it to 0, and passes the inserted entry's duration only when `selfFraction` isn't 0, taking it from the entry's timings at position 0.

**These throw a `SyntaxError`** at `add`, with the reason after `Can't parse the position "…":`:
- `=` without `%` (`'+=1'`);
- two offsets of one kind (`'<+1-1'`), or offsets out of order (`'<-1+50%'`);
- an offset without a sign (`'<0.2'`), or anything else after an offset;
- a sign without an amount after it (`'<+-1'`, `'>-+50%'`);
- a name before `<<` or `>>` (`'title<<'`, `'title>>'`);
- an amount that isn't a number (`'+abc'`).

`checkPositionDescriptor`, next to the parser, then throws an `Error` for a reference to a name that isn't an earlier entry, and a `RangeError` for any offset that isn't finite (`'+Infinity'`).

**The type.** `At<Name>` is a template literal type over the names given so far, so positions can only refer to earlier names. `Name` defaults to `string`, so a bare `At` takes any name. Its offsets are three optional slots in their order, so the type rejects repeated and out-of-order offsets too.

#### 2.7.2 Reach

Times are local to the sequence an entry is in.

| Term | Meaning |
|---|---|
| **Start** | The entry's position, before its delay. References to an entry's start resolve to it. |
| **Anchor duration** | From the start to where the entry ends. An infinite repeat counts only its first play, since infinity can't be referred to. An entry with no elements has 0.<br>• **An animation's:** its latest staggered delay, then its plays and their repeat delays.<br>• **A sequence's:** until the latest end among its entries. |
| **End** | The start plus the anchor duration. References to an entry's end resolve to it. |
| **Duration** | For positions, an entry's `EntrySpan` runs from its start for its anchor duration. The inserted entry's doesn't depend on its position, so it's known before the entry is placed. |
| **Previous entry** | The entry added just before. For the first entry, it's the start of the sequence, with a duration of 0. |
| **Everything so far** | From 0 to the latest end among the earlier entries, or 0 with none. |

- A position that resolves below 0 becomes 0.
- References never reach into subsequences.

## 3. Definitions and Controls

### 3.1 Overview

| | Value-free | Bound | Running |
|---|---|---|---|
| One animation | `AnimationTiming` | `AnimationDefinition` | `AnimationControls` |
| A sequence | `SequenceTiming` | `SequenceDefinition` | `AnimationControls` |

- **A definition** is a timing bound to targets and values. It's everything needed to play, with no playback state. `Definition` is `AnimationDefinition | SequenceDefinition`.
- **An animator's `animate()`** turns a definition into running animations and returns their controls. A definition can be played any number of times, by any animator, in any scope.
- **Definitions are DOM-bound:** targets are elements, and values are CSS. The animator decides the engine: `animator()` gives a `WAAPIAnimator`, and there's no other yet.
- **Definitions are immutable,** and so are their builders.
- `AnimationDefinition`, `SequenceDefinition` and the builders are exported as types only. The functions make them.

### 3.2 `animation()`

```ts
function animation(target: Target, values: AnimationValues, timing: AnimationTiming | AnimationTimingOptions): AnimationDefinition;
```

| When | What happens |
|---|---|
| `animation()` | The timing is made and validated, and each property's values are made into `TweenStops`, which check their forms (§3.4). Both throw here. |
| An animator's `animate()` | The target is resolved in the animator's scope as the definition is planned, the values are read against each element, and the animations are created (§3.7). |

**The timing** is an `AnimationTiming`, used as it is, or `AnimationTimingOptions`, which go through `AnimationTiming.of`. Every property in `values` runs on it. There's no timing per property.

### 3.3 Targets

```ts
type CSSSelector = string;
type Target = Element | Iterable<Element> | CSSSelector | ((scope: Element) => Element | Iterable<Element>);
```

- **Resolution** (`resolveTargets`, at `animate`, as the plan is made, §5.1): a selector is `scope.querySelectorAll`, and a function is called with the scope. A target, or what its function returns, is one element or any iterable of them, such as an array or a `NodeList`. A string is never taken as an iterable: it's always a selector.
- **Elements are deduplicated** in order. An element's index in that order is what staggers use: document order for a selector.
- **No elements plays nothing:** the animation takes no time, whatever its duration and repeats, so its entry in a sequence keeps its position and takes no time there.

### 3.4 Values

```ts
type CSSValue = number | string;
type RawTweenStops = CSSValue | readonly (CSSValue | null)[] | { [progress: number]: CSSValue | null };
type AnimationValues = { [property: string]: RawTweenStops };
```

**Forms to stops.**

| Form | Stops |
|---|---|
| `v` | `{1: v}` |
| `[v]` | `{1: v}`: a single keyframe is the last, as in WAAPI |
| `[v₀, …, vₙ]`, n ≥ 1 | vᵢ at i / n |
| `{p: v, …}` | as keyed |
| `null` at 0 or 1 | that stop is missing |
| `null` between the ends | skipped |

- **`TweenStops`** (`src/tween-stops.ts`) are one property's stops, in order of offset, with a stop at each end. `TweenStops.of(property, rawStops)` turns a form into them: keys outside 0–1 throw a `RangeError`, a `null` is left out wherever it is, and a form left without values throws a `TypeError`. Its constructor is private, so every instance is one `of` checked.
    - **The ends:** a missing 0 becomes a stop whose value is `null`, which stands for the value underneath as the entry starts. A missing 1 becomes a stop with the last given value (see below).
    - `startValue` and `endValue` give the values of the stops at 0 and 1.
    - `get(offset)` gives the value of the stop at exactly that offset, or `undefined` when there's none.
    - `reverse()` gives new stops with each value at 1 minus its offset, in order. A mirrored play runs through them (§5.4).
    - `TweenStops.constant(value)` holds one value from 0 to 1, for the holds in a run (§5.4).
    - The values stay as given, numbers or CSS text, until the tracks' values are resolved (§5.6).
- **When the forms are checked:** as the definition is made. An `AnimationDefinition` makes `TweenStops` of every property and keeps them as `stopsByProperty`: in `animation()`, in an inline sequence entry, and for every animation entry of a mapping given to `sequence()`. Playing reads those, and never meets an invalid form.
- **A missing 0** is the value underneath as the entry starts: the value its track shows then (§5.6), or the property's current value when `animate` is called.
- **A missing 1** is the value underneath as the entry ends. §5.6 only resolves missing starts so far, so a missing 1 takes the last given value for now (`TweenStops.of`).
- **Between stops,** the value is linear in the progress. Past the ends, as a spring overshoots, it continues the nearest segment.
- **Properties** are camelCase. Custom properties are written as they are (`--like-this`). `float` and `offset` become `cssFloat` and `cssOffset` in keyframes (§5.8).
- **Value types and units** come from `CSS.supports`, per property (§5.2).
- **Passing through or resolving to numbers:** values pass through to WAAPI as their CSS text wherever every keyframe lands on a stop, and are resolved to numbers in one unit otherwise (§5.6). Where they need numbers, a property must take a single number: `transform` and two-value `translate` aren't supported there.

### 3.5 `sequence()`

```ts
function sequence(): SequenceDefinitionBuilder;
function sequence<Timing extends SequenceTiming>(timing: Timing, mapping: SequenceMapping<Timing>): SequenceDefinition;
```

**The builder.**

```ts
interface EntryPlacementOptions<N extends string, Names extends string> {
    name?: N;
    at?: At<Names>;
}

class SequenceDefinitionBuilder<Names extends string = never> {
    add<N extends string = never>(
        target: Target,
        values: AnimationValues,
        timing: AnimationTiming | AnimationTimingOptions,
        placement?: EntryPlacementOptions<N, Names>
    ): SequenceDefinitionBuilder<Names | N>;

    add<N extends string = never>(
        definition: AnimationDefinition | SequenceDefinition,
        placement?: EntryPlacementOptions<N, Names>
    ): SequenceDefinitionBuilder<Names | N>;

    build(): SequenceDefinition;
}
```

- **Forms.** A first argument that's an `AnimationDefinition` or a `SequenceDefinition` is a definition entry. Otherwise it's inline. A target is never a definition, so `instanceof` decides, and argument shapes are never guessed.
- **The inline form** is `add(animation(target, values, timing), placement)` flattened.
- **`add` checks nothing,** except that an inline entry's `animation()` is made there. Names and positions are only checked by the `SequenceTiming` builder at `build`, under the names entries end up with, so their mistakes throw at `build`. A position that refers to an automatic name (`'a>'`) is a type error, but at runtime it refers to that entry.
- **Names are optional.** Given names join `Names`, which types `at`. Entries without a name can't be referred to.
- **Immutable:** each `add` returns a new builder with its own copy of the entries.
- **Private constructors.** `SequenceDefinition` and `SequenceDefinitionBuilder` are guarded the way `SequenceTiming` and its builder are (§2.7), with a license symbol private to `src/sequence.ts`. Constructing either directly throws a `TypeError`: `A SequenceDefinition can only be created using SequenceDefinitionBuilder or SequenceDefinition.of.`, or `Use sequence to create a SequenceDefinitionBuilder.`, and `Illegal constructor` in a production build.
- **`build`**:
    1. names the unnamed entries in order, as `a` to `z`, then `aa`, `ab` and on, skipping the names given;
    2. compiles the entries' timings into a `SequenceTiming`, and keeps each entry's definition as it is, with its name, in the definition's `entries` (§3.7);
    3. throws for a sequence without entries.

**From a sequence timing.**

```ts
type AnimationMapping = [target: Target, values: AnimationValues];

type SequenceMapping<Timing extends SequenceTiming = SequenceTiming> = {
    [Name in entry names of Timing]: entry is a SubsequenceTimingEntry
        ? SequenceMapping<its SequenceTiming>
        : AnimationMapping;
};
```

- The mapping mirrors the timing's tree, keyed by entry name, with a nested mapping for each subsequence timing.
- An animation entry's mapping is a `[target, values]` pair. A sequence's is a plain record of its entries' mappings, so the two are told apart by `Array.isArray`.
- Every entry must be mapped. The type requires it, and `sequence()` throws `No mapping present for "<path>".` An animation entry's mapping that isn't a `[target, values]` pair throws `The mapping of "<path>" needs a target and values.`, and its values are checked as `animation()`'s (§3.4).
- `SequenceMapping` with no argument is the mapping of any sequence timing.
- **`SequenceDefinition.of(timing, mapping)`** is what `sequence(timing, mapping)` calls. It makes the definition's `entries` from the mapping: an `AnimationDefinition` for each animation entry, from its timing and its `[target, values]`, and a `SequenceDefinition` for each subsequence, from its timing and its nested mapping.
- It returns a `SequenceDefinition`, the same as `build()`, so it can be played or added to another sequence.

### 3.6 Overlaps

When entries animate the same property of the same element (§5.5):

- The one declared later shows over the earlier one while it runs.
- An earlier entry that falls entirely within a later one is dropped.
- Only the entry that starts first holds its start values before it starts.
- An entry holds its end values after it ends, unless one declared before it is still running.

### 3.7 Playing

```ts
interface AnimatorOptions {
    scope?: Element;          // document.documentElement by default
}

function animator(options?: AnimatorOptions): Animator;

abstract class Animator {
    animate(target: Target, values: AnimationValues, timing: AnimationTiming | AnimationTimingOptions): AnimationControls;
    animate<Timing extends SequenceTiming>(timing: Timing, mapping: SequenceMapping<Timing>): AnimationControls;
    animate(definition: Definition): AnimationControls;
    protected abstract animateDefinition(definition: Definition): AnimationControls;
}
```

- **An animator animates in one scope** (`src/animator.ts`). `animator` gives a `WAAPIAnimator` (`src/waapi/animator.ts`), which extends `Animator`. Other engines would extend it too.
- **`animator` lives with `WAAPIAnimator`,** not in `src/animator.ts`. There, it would make `src/animator.ts` import the subclass, and the subclass would be evaluated before the class it extends exists. The scope defaults to `document.documentElement` at each `animate`, not when the animator is made, so an animator can be made where there's no document.
- **`animate`'s three forms.** The first two take what `animation()` and `sequence(timing, mapping)` take, and make the definition with them, so their checks throw at `animate`. A definition is played as it is. `Animator.animate` tells them apart by the first argument: an `AnimationDefinition` or `SequenceDefinition`, a `SequenceTiming` (through `SequenceDefinition.of`), or else a target, which can never be any of these. It passes the definition to `animateDefinition`, the one method each engine implements.
- **Each `animate`** plans the definition, which resolves its targets in the scope, then resolves the tracks, with their values per element, and calls `element.animate()` for each effect (§5).
- **What a definition holds:** an `AnimationDefinition` its `timing` (an `AnimationTiming`), `target` and `stopsByProperty` (a `TweenStops` per property, §3.4); a `SequenceDefinition` its `entries` and its `timing` (a `SequenceTiming`).
- **`SequenceDefinitionEntries`** (`src/sequence.ts`) are one ordered array, in the order of the timing's entries, as `SequenceTimingEntries` are (§2.7). Each is `{name, animation}` (`AnimationDefinitionEntry`, with an `AnimationDefinition`) or `{name, sequence}` (`SubsequenceDefinitionEntry`, with a `SequenceDefinition`), so every leaf is an `AnimationDefinition`. Positions stay in the timing.
- **Definitions expose nothing.** Their fields are `@internal`, and so is `AnimationDefinition`'s constructor; `SequenceDefinition`'s is private (§3.5). Besides `SequenceDefinition.of`, they have no methods: animators read their fields.
- **It always starts playing.** There's no `autoplay`: pausing right after `animate` shows no motion, because no frame renders in between.
- **Animation `id`s** are the entry path and the property, `path:property`, or the property alone for an animation on its own. The path is the entry names leading to the leaf, joined by `>` (§2.7).

### 3.8 Controls

`AnimationControls` (`src/waapi/controls.ts`) wraps the native `Animation`s of one play.

| Member | Behaviour |
|---|---|
| `play()`, `pause()`, `cancel()` | Called on every animation. |
| `finish()` | Called on every animation. It throws while one repeats forever, as WAAPI's does. |
| `seek(time)` | Sets every animation's `currentTime` to `time` × 1000. `time` is seconds from the start of the definition. |
| `playbackRate` | Gets the first animation's, or 1 with none. Sets every animation's. |
| `startTime` | Seconds on the timeline. Gets the first animation's, or `null` when it's unresolved or there are none. Sets every animation's. |
| `finished` | `Promise.all` of every animation's `finished`, resolving to `undefined`. A new promise on each access. It never settles while an animation repeats forever. |
| `onFinish(listener)`, `onCancel(listener)` | Calls the listener each time every animation has dispatched that event since the last call. Returns a function that removes the listener from every animation. |
| `animations` | The native `Animation`s, in creation order. |
| `retarget` | `@internal`. Declared, with a stub that throws. |

- **Animations hold their end values** after they end. Cancelling the controls lets go of them.
- **`retarget` (planned):**
    1. keep the effects as they are before they become native;
    2. read the current time and find the active span's stops and easing;
    3. take the velocity by the chain rule: dValue/dProgress × dProgress/dOffset × dOffset/dt;
    4. start the new motion from the current value and velocity, evaluating CSS values where needed and throwing only when they can't share a unit.

  Interruptions are built on it.

### 3.9 Exports

| Kind | Exports |
|---|---|
| Functions | `animator`, `animation`, `sequence`, `stagger`, `cubicBezier`, `steps` |
| Classes | `AnimationTiming`, `SequenceTiming` |
| Definitions and controls (types) | `AnimationDefinition`, `SequenceDefinition`, `Definition`, `SequenceDefinitionBuilder`, `SequenceTimingBuilder`, `Animator`, `AnimatorOptions`, `AnimationControls` |
| Targets and values | `Target`, `CSSSelector`, `CSSValue`, `RawTweenStops`, `AnimationValues` |
| Placement and mappings | `EntryPlacementOptions`, `AnimationMapping`, `SequenceMapping` |
| Timing | `AnimationTimingOptions`, `PlaybackOptions`, `PlaybackDescriptor`, `RepeatOptions`, `RepeatMode`, `Stagger`, `StaggerSpacing`, `StaggerOptions`, `StaggerOrigin` |
| Sequence entries and positions | `SequenceTimingEntries`, `SequenceTimingEntry`, `AnimationTimingEntry`, `SubsequenceTimingEntry`, `At`, `PositionDescriptor`, `PositionReference`, `PositionAnchor`, `PositionOffset` |
| Transitions | `TransitionOptions`, `EasedTransitionOptions`, `SpringTransitionOptions`, `DurationSpringTransitionOptions`, `VisualSpringTransitionOptions`, `PhysicalSpringTransitionOptions` |
| Easings | `EasingSpecifier`, `EasingPreset`, `CubicBezierEasingParams`, `StepsEasingParams`, `StepPosition` |
| Units | `Seconds`, `Progress` |

### 3.10 Errors

Every error has the type of what went wrong:

| Type | Thrown for | Examples |
|---|---|---|
| `RangeError` | A number out of range | a negative duration, `NaN` or an infinite time, a `bounce` outside −1–1, a value key outside 0–1, a steps count below 1, a cubic Bézier `x` outside 0–1 |
| `TypeError` | An input of the wrong shape or kind | a transition missing a required key or mixing kinds, an easing that isn't a preset or params, an unknown `repeatMode`, `step` with `spread`, no values, a missing mapping entry or one that isn't `[target, values]`, a value the property doesn't take, a sequence timing or definition, or either's builder, constructed directly |
| `SyntaxError` | A position that doesn't parse | `'<0.2'`, `'+=1'`, `'<+1-1'` |
| `Error` | Anything else | a duplicate or invalid name, a reference to a later entry, an empty sequence, values that end up in different units |

## 4. Code layout

| File | Responsibility |
|---|---|
| `src/types.ts` | Units: `Seconds` and `Progress` |
| `src/constants.ts` | `PRECISION`: how close two progresses must be to count as the same |
| `src/easing-specifier.ts` | Easing specifiers, `cubicBezier`, `steps`, the presets and `linear`, `checkEasingSpecifier` and `resolveEasing` |
| `src/easing.ts` | The windowed easing classes, their params types (`CubicBezierEasingParams`, `StepsEasingParams`, `StepPosition`), and the checks of their params |
| `src/cubic-bezier.ts` | Cubic Bézier math: coordinates, inverses, turning points, inflections, splitting |
| `src/damped-spring.ts` | Closed-form damped springs in each damping regime: positions, turning times, rest time, and the factories each spring kind is made with: `physical`, `visual`, and `restingAt`, which solves a spring that comes to rest at a duration |
| `src/transition.ts` | Transition options: their kinds, their keys, telling them apart, checking them, and resolving each one, once, into a `TransitionDescriptor` |
| `src/playback-options.ts` | `PlaybackOptions`, `PlaybackDescriptor`, `RepeatOptions`, `RepeatMode` and `Stagger`, their checks and their clamps, `checkedStaggerOf` and `playbackDescriptorOf` |
| `src/stagger.ts` | The `stagger` utility, `StaggerSpacing`, `StaggerOptions` and `StaggerOrigin` |
| `src/animation-timing.ts` | `AnimationTiming`, `AnimationTimingOptions` and `TimedTweenTiming`, with validation and clamping |
| `src/at.ts` | `At`, `PositionDescriptor`, `parsePositionDescriptor`, `checkPositionDescriptor` and `resolvePosition` |
| `src/sequence-timing.ts` | `SequenceTimingBuilder`, `SequenceTiming` and its entries, with validation, and entry paths (`EntryPath`, `entryPathOf`) |
| `src/tween-stops.ts` | `TweenStops`: one property's stops, read from their forms and checked, with a stop at each end |
| `src/animation.ts` | `animation` and `AnimationDefinition` |
| `src/sequence.ts` | `sequence`, `SequenceDefinition`, `SequenceDefinitionBuilder`, its entries, `Definition` and `EntryPlacementOptions`, and making a sequence timing's entries' definitions from its mapping |
| `src/animator.ts` | The `Animator` abstract class, which turns `animate`'s forms into a definition for the engine's `animateDefinition` |
| `src/internals.ts` | The internals `site/` uses, which it imports as `timesfps/internals`; `tsconfig.json` leaves it out of the build |
| `src/utils/validation.ts` | `checkNumber`, `checkPositive`, `requireNumber` and `requireProperty` |
| `src/utils/environment.ts` | `isProduction`: whether a bundler built it for production, from `process.env.NODE_ENV`; false where `process` doesn't exist |
| `src/utils/math.ts` | Interpolation and solving monotone functions |
| `src/utils/records.ts` | Reading numeric-keyed records in order |
| `src/resolution/plan.ts` | `plan`, through `AnimationPlanner` and `SequencePlanner`: the plan tree of positions and durations, with each animation's targets and their delays |
| `src/resolution/stops.ts` | `NumericStops`: one property's values as numbers in one unit, and interpolating them |
| `src/resolution/track-runs.ts` | `TrackSpan` and `TrackRun`: a track's values over time, and their iterations |
| `src/dom/mapping.ts` | What binds a timing to the DOM, for any DOM adapter: targets, value forms (`RawTweenStops`), mapping types, `AnimatorOptions`, and resolving targets |
| `src/waapi/animator.ts` | `animator`, and `WAAPIAnimator`, the `Animator` for WAAPI, which runs every step and creates the native animations |
| `src/waapi/controls.ts` | `AnimationControls`: playing, pausing, seeking and listening to the native animations together |
| `src/waapi/css-values.ts` | CSS property names, value types, and the page's value resolver, which writes bare numbers as CSS text |
| `src/waapi/effect-chains.ts` | The values stage: effect chains, resolving their values to numbers in one unit, and `EntryValues` |
| `src/waapi/tracks.ts` | `AnimationTracksResolver`: repetitions, fill conflicts and values, over track runs |
| `src/waapi/native-effects.ts` | The easing stage: spans into native keyframes and easings |
| `src/waapi/native-easing.ts` | `NativeEasing` and its CSS form |
| `src/waapi/spring-fit.ts` | Fitting a spring easing with cubic Bézier segments |
| `stash.ts` | Outside the build and the tests: the code and tests that played a sequence's delay, stagger and repeats, kept for reimplementing them |

Relative imports end in `.ts`, and `rewriteRelativeImportExtensions` makes the build emit `.js`. Turbopack doesn't map `.js` imports to `.ts` files, so this is what lets the site load the source.

`site/` is the demo site. Its `tsconfig.json` aliases `timesfps` to `src/index.ts` and `timesfps/internals` to `src/internals.ts`, so it runs the library's source with one copy of every class, which the library's `instanceof` checks need. Its spring page checks spring fits by eye: the fitted spline, and the keyframes the adapter plays, each against the spring.

## 5. Adaptation flow

```
new WAAPIAnimator({scope}).animate(definition)    scope: document.documentElement by default
│
├─ 1. Plan         plan(definition, targetsResolver)  → AnimationPlan | SequencePlan tree
│                  (targets resolved §5.1, positions and delays §5.3; values stay as given §5.2)
├─ 2. Tracks       AnimationTracksResolver.resolve(plan, domValueResolver)
│     ├─ a. repetitions    → ScheduledEffect[]  (spans per element and property)
│     ├─ b. fill conflicts → PlacedEffect[]    (dropped effects, fill modes)
│     ├─ c. values         → ResolvedEffect[]  (units, or values passed through as text, and each entry's EntryValues)
│     └─ d. easings        → NativeAnimationEffect[]  (keyframes, native easings)
│                  = AnimationTracks: Map<Element, {[property]: NativeAnimationEffect[]}>
└─ 3. Play         element.animate(...) per effect
                   → AnimationControls
```

The plan walks the definition tree, which holds every target and value, so nothing is looked up by path. Every animation leaf is still named by its **entry path**: the names leading to it joined by `>`, such as `intro>logo>fade`. Names can't contain `>`, so paths can't collide. The tracks stage builds the paths as it walks the plan, and uses them to tell a track's entries apart (§5.6) and to name the animations (§5.8).

### 5.1 Targets

The plan resolves each animation definition's target as it reaches it, through the `TargetsResolver` it's given. The animator's resolves each target once per `animate`, however many times a sequence plays it, through `resolveTargets` (§3.3): a selector is queried in the scope, and a function is called with it. Elements are deduplicated. An animation with no elements has a play and anchor duration of 0, so it starts and ends at its position.

### 5.2 Values

Values stay as given, numbers or CSS text, in each definition's `TweenStops`, through the plan and the repetitions. Stage c (§5.6) resolves them per track, so per element, because units like `em`, `%` and `vw` depend on the element, and because an entry's missing 0 depends on what that element's track shows. There, a bare number becomes CSS text through the resolver's `textOf`, which on the page adds the property's default unit, and values are resolved to numbers where they need to be.

A property's **value type** comes from `CSS.supports`, tested against `1`, `1px`, `1%`, `1deg` and `1s`, and cached per property. It's only looked up for a bare number, or to resolve a value. It gives:
- the **default unit** for a bare number: none when the property takes numbers, then `px`, then `deg`; otherwise a bare number throws;
- the **probe syntax**, such as `<length-percentage>` or `<number> | <percentage>`.

Nothing is resolved in place. Stage c gives each entry on each track an `EntryValues` (`src/waapi/effect-chains.ts`): the text of any of the entry's values, with `null` as the value underneath at its start, and, once the entry's chain is resolved to a unit, their numbers, as `NumericStops` (`src/resolution/stops.ts`) to interpolate. Reversed stops, holds and every repeat hold the entry's own values, so they all read through its `EntryValues`.

### 5.3 Plan

`plan(definition, targetsResolver)` (`src/resolution/plan.ts`) places the definition in time, through the internal `AnimationPlanner` and `SequencePlanner`. It returns a tree with the definition's levels, an `AnimationPlan` for each animation and a `SequencePlan` for each sequence, holding what playing it needs. Times are local to the sequence an entry is in, or start at 0 for the outermost definition.

| Field | Meaning |
|---|---|
| `definition` | The node's definition: its timing, and an animation's `stopsByProperty` |
| `entries` | A sequence's: each entry's node, by name, in order |
| `position` | Where the entry starts in its sequence, before its delay; 0 for the outermost definition |
| `playDuration` | One play of an animation, without delays or repeats. A sequence's runs from 0 to the latest end among its entries, gaps included |
| `easing` | An animation's only: the easing its transition resolves to (§2.2) |

Leaves also keep `targets`: each element as `target`, with its `delay`, the animation's own (its number, or its stagger at the element's index).

**Planning in steps.** Each planner plans one entry, once:
1. `of(definition, targetsResolver)` takes everything that doesn't depend on where the entry sits. An `AnimationPlanner` resolves the targets, each target's own delay, the easing and the durations. A `SequencePlanner` plans its whole subtree, as below.
2. `position(descriptor, entrySpans)` resolves the position among the entries before it, clamped to 0. A `=%` offset reads the planner's own anchor duration, which is already known.
3. `plan()` gives the node.

The anchor duration (§2.7.2) stays in the planners: only placing the entries after an entry and working out its sequence's durations need it, and both happen while planning.

`SequencePlanner.of` makes a planner for each entry, positions it, keeps its `span` for the positions after it, and plans it. A sequence's play duration and anchor duration are both the latest end among its entries.

### 5.4 Tracks, stage a: repetitions

**Spans and runs.** A `TrackSpan` is a stretch of one element's property, from `start` to `end`, whose value is its stops' value at `easing.progressAt(x)`. Its stops are `TweenStops`, with their values still as given. A hold is a span with constant stops (`TweenStops.constant`) and a linear easing. A `TrackRun` is spans one after another. `TrackRun.iteration(index, iterationDuration, options)` places a run in an iteration of a repeat. Every other iteration of a reverse or a mirror flips in time:
- a reverse reverses each span's easing window;
- a mirror keeps the easing and reverses the stops (`TweenStops.reverse`).

**The rule.** Every repeat is an animation's own, and runs as WAAPI iterations.

**Unrepeated runs.** Walking the plan gives an `UnrepeatedRun` for each element and property of each animation: one play as a run, the iteration it repeats in (`iterationDuration`, the play's duration), its `repeatOptions`, and its `offset`. The offset is the animation's position plus the element's `delay`, plus the position of every sequence around it. Each unrepeated run then becomes effects through the native layout below, made later by its offset.

**Plays without duration.** A play of 0 seconds is a span that starts and ends at the same time. Inside a longer effect it's two keyframes at the same offset, its start values and then its end values, so the track jumps. An effect of 0 seconds has two keyframes: the start values at 0 and the end values at 1. WAAPI shows the start values before it, if it fills backwards, and the end values from its start time on.

**Native layout.** For a run from `a` to `b` in iterations of `L` with repeat delay `d`, where the period is `P = L + d`:

| Case | Effects |
|---|---|
| No repeat | the run |
| No repeat delay, not mirror, the run fills the iteration | the run × playCount, `alternate` for reverse |
| Loop | [run + hold to `a + P`] × repeat, then the run on its own; × ∞ alone when infinite |
| Reverse/mirror, infinite | [run + hold, flipped + hold] × ∞ |
| Reverse/mirror, odd play count | [run + hold, flipped + hold] × repeat/2, then the run on its own |
| Reverse/mirror, two plays | [run + hold, flipped] on its own |
| Reverse/mirror, even play count | [run + hold, flipped + hold] × (repeat−1)/2, then [run + hold, flipped] on its own |

The last play never ends with a hold. The first effect starts at the run's start, so a hold before it is covered by the native delay. The holds between iterations, `[endHold + repeatDelay + startHold]`, are in the keyframes.

**Declaration order.** Each effect gets an order key: the entry indices leading to its leaf, plus a part index. Effects are created in this order, and WAAPI shows later-created effects over earlier ones.

### 5.5 Tracks, stage b: fill conflicts

Per target and property, in declaration order:

- **Drop:** an effect that lies entirely within the active span of one declared later never shows, so it's dropped.
- **Backwards:** only the effects that start first fill backwards.
- **Forwards:** an effect fills forwards unless an effect declared before it runs on after it ends.

An effect's end is its delay plus its active duration, which is 0 for an effect of 0 seconds, whatever its iterations.

Entries are never merged: where two entries on the same property of the same target overlap, the later-created one covers the other.

### 5.6 Tracks, stage c: values

`resolveEffectChains` resolves each track's stop values, in `src/waapi/effect-chains.ts`. Values pass through to WAAPI as their CSS text wherever that's exact, and are resolved to numbers only where keyframes fall between them. It works through a `CSSValueResolver`, which gives a value's CSS text, a property's current value, whether it takes a value, and a value's computed form. On the page that's `domValueResolver`: computed styles, `CSS.supports` and probes. Tools that animate no real property use `plainNumberResolver`.

**Chains.** The track's entries, told apart by their entry paths, are taken in order of their first start, and of declaration when they start together.
- An entry with a value at 0 starts a chain.
- An entry without one depends on the effect showing at its start. That's the last-declared effect of an earlier entry that shows a value then, as WAAPI works it out from its delay, iterations, direction and fill. The entry joins that effect's chain.
- With no such effect, it starts a chain from the property's current value.

**Starts.** In order, each entry without a value at 0 takes a text: the property's current value for a chain's first entry, or the stop value its effect shows at its start. That's a stop's when the effect is at a whole span's end, or anywhere through a hold. Between stops there's no text, and the start only gets a number, below.

**Passing through.** An effect's values pass through as text when `landsOnStops` holds and its entry's start has text. `landsOnStops` holds when every keyframe lands on a stop: its easing is on the effect, or each span eases between exactly two stops through one native easing (cubic Bézier, steps or linear) that needn't be split. Its window covers the whole easing, forwards or backwards, and it makes one native piece. An overshoot needn't be split: with two stops, the value runs linearly with the progress past them too, as WAAPI extrapolates between two keyframes. A chain whose effects all pass through is only checked: each given value must be one the property takes. Any other chain is resolved to numbers, and its effects that pass through still use their text.

**Units.** A resolved chain shares one unit, and its values with text are resolved to numbers in it:
- **From the current value:** the current value must be a single number with a unit, and that's the unit. Every other value in that unit is taken as it is. The rest are checked with `CSS.supports` and resolved through a probe, and they must come out in that unit.
- **From a given value:** if every value is a number in one unit, the property must take that unit, and they're taken as they are. Otherwise the expressions are checked and resolved. If the units still differ, every value is resolved. If they differ even then, it throws.

A unit mismatch throws with what to do instead: values in one unit, or expressions that resolve to one; or, to have values passed through, only native easings, no values between 0 and 1 where repeats are played as keyframes, and no entry without a 0 starting between two values of the one under it.

Then, in order, each start without text takes the number its effect shows there, which needs that effect's values to be numbers already. Each effect gets the unit of its chain, or none when its values pass through, and its entry's `EntryValues`.

A probe is a registered custom property (`--timesfps-probe-N-a`/`-b`) with the property's syntax. It's set inline on the target with `transition: none !important` while its computed value is read, then the inline style is restored. Animations and transitions never touch a probe, and its computed value is absolute: `calc()` collapses, lengths become px, and angles become deg. Percentages stay percentages.

Each syntax has two probes with different initial values. A value that the syntax rejects reads as the initial value on both, which tells it apart from a value that happens to equal one of them. A resolved value must be a single number with an optional unit, or it throws.

### 5.7 Tracks, stage d: easings

`nativeEffectOf` turns each placed effect into a `NativeAnimationEffect`, whose keyframe values are CSS text: the stops' own when the effect passes them through, or each number with its unit.

- **On the effect.** If the effect is a single span covering its whole duration, with a whole, forward, non-spring easing and stops within 0–1, the easing goes on the effect and the stops become linear keyframes at their progress. Native iterations with `alternate` keep it there.
- **In the keyframes.** Otherwise the effect easing is linear and each span is split into keyframes:
  1. A spring is fitted once per spring and duration, as a spline of cubic Bézier segments. The segments that overlap its window are cut to it.
  2. Each segment is split where its progress turns back, so each piece only rises or only falls.
  3. Each piece is split where it passes a stop, so between two keyframes the value runs linearly with the progress.
  4. Each piece becomes a native easing, scaled to 0–1:
     - **Cubic Bézier:** the window is cut out of the curve and stretched. If stretching would push a handle outside the 0–1 time range, it's split once more at the inflection of x. Reversed windows reverse the definition.
     - **Steps:** a whole forward window from 0 to 1 stays a native `steps()`. Any other window becomes a `linear()` whose levels jump at the step positions, so steps never add keyframes.
     - **Linear:** linear.
- **Keyframe easings** lead to the next keyframe, as WAAPI's do. A keyframe without one is linear, and the last keyframe has none.
- **Offsets** are clamped to 0–1 and kept in order, because rounding can push them out and WAAPI rejects that.

### 5.8 Play

For each target, property and effect, in order, the adapter calls `element.animate()`:
- keyframe values are their CSS text;
- times are converted to milliseconds;
- `float` and `offset` become `cssFloat` and `cssOffset`, since `offset` is the keyframe's own;
- the animation's `id` is its entry path and property, `path:property`, or the property alone for an animation on its own (§3.7).

`animate` returns an `AnimationControls` over the native `Animation`s. It plays, pauses, cancels, finishes and seeks all of them together, and sets their playback rate and start time, in seconds. `finished` settles once they all have. `onFinish` and `onCancel` call a listener each time every animation has dispatched that event, and return a function that removes it.

## 6. Decisions

| Decision | Why |
|---|---|
| Definitions are value-free; every change is 0→1 | One definition serves any properties, targets and engine |
| Duration lives in the transition | A physical spring's duration comes from its physics |
| Spring quantities are in progress units | Values don't exist at definition time, and spring motion scales linearly |
| Timings validate and store; the plan resolves each transition, once | Resolving isn't a timing's job. The checks still throw where mistakes are made, and every play of a timing shares one easing |
| Easings are windowed and keep raw progress | Splitting, cutting and reversing are all window operations, and a spring window can start and end at the same progress |
| Easing math in the core, WAAPI conversion in the adapter | Spline fitting, CSS pieces and `linear()` are engine concerns |
| Mirror flips the progress and keeps the easing | That's what makes a mirrored spring settle the way it started |
| Animations are unnamed; entries are named | The same animation can be placed many times |
| Positions and references are local to each sequence | Entry names only need to be unique within their sequence |
| The plan is resolved at adaptation | Staggers depend on the element count, which only the targets give, resolved in the scope |
| Errors by kind: `RangeError`, `TypeError`, `SyntaxError`, `Error` | A caller can tell a bad number, a bad shape, a bad position and a bad state apart (§3.10) |
| A track's entries told apart by entry path | Definitions are reusable, so identity is the place in the tree, not the object |
| Values resolved per target, through probes | Relative units depend on the element; probes are untouched by animations and give absolute values |
| Values resolved after the fill conflicts | A missing 0 depends on which effect shows at the entry's start, and only interpolation needs numbers |
| Constructors validate and clamp | Every way of making a definition is checked, not only the factories |
| Tracks per target and property | WAAPI stacks effects per property, and units differ between entries |
| Fill rules instead of merging entries | Keeps entries independent |
| Keyframe easings lead to the next keyframe | It's WAAPI's own model |
| Steps split into `linear()` windows, not hold-and-jump keyframes | Exact, and no extra keyframes |

## 7. Testing

`tests/tracks.test.ts` simulates how WAAPI computes effects and shows them over each other:
- iterations and directions;
- fills;
- keyframe intervals;
- cubic Bézier, steps and `linear()` easings;
- the last effect with a value showing.

It compares the result with the definitions' own math, sampled at times that miss round numbers, where steps and repeats jump. The definitions' math is: each play through the stops and easing, holds through repeat delays, `reverse` as time reversal, and `mirror` as `1 − progress` with the easing running forwards.

The cases cover single animations through every repeat, and entries in sequences. Easings are cubic Bézier (including overshoot), jump-start and jump-end steps, and springs. Plan, timing, fill and drop cases are checked exactly.

`tests/animation.test.ts` covers timings: validation and clamping, telling transition kinds apart, splitting `AnimationTimingOptions`, the `DampedSpring` factories, and staggers. `tests/sequence.test.ts` covers positions (parsing, one offset of each kind in order, and resolving every reference and share), sequence timings, targets, tween stops (their forms, their ends, `get` and `reverse`), and definitions: values checked as they're made, naming, immutability, their entries, and private constructors.

Effect chains are tested through a stand-in `CSSValueResolver` that takes plain numbers and gives every property a current value of 0.25. The tests run without a DOM. `tests/play.test.ts` plays definitions on a stand-in one and checks the animations' ids and staggered delays, but `domValueResolver`, probes and real elements have no tests yet.

`tests/readme-examples.test-d.ts` type-checks the README's examples, and the mistakes the README says the types reject. `npm test` runs it through Vitest's type checking, with `tests/tsconfig.json`, which includes the type tests.

## 8. Limitations and open work

- **Ending on the value underneath.** A missing 1 takes the last given value (§3.4), until §5.6 resolves it.
- **Timed tweens** exist as `TimedTweenTiming`, which is internal and can't be placed in a sequence or played yet.
- **The before flag.** Only an effect's own easing gets WAAPI's before flag. So an effect whose first keyframe starts with a jump, such as jump-start steps split by a stop or a reversed jump-end, shows the jumped value during its backwards fill.
- **Sequences have no playback options:** no delay, stagger or repeats. The code and tests that played them are kept in `stash.ts`, for reimplementing them.
- **Probes are global.** They're registered once per document and can't be unregistered.
