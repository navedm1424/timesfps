# TimesFPS: Implementation Spec

This document is for people working on the library. It covers what the library is for, its API surface, how the code is laid out, how a definition becomes running WAAPI animations, and why things are the way they are.

The library lives in `src/`. The plan and tracks stages, which any adapter may use or not, are in `src/tracks/`, the WAAPI adapter is in `src/waapi/`, and the tests are in `tests/`.

> **Status.** The code implements §1–§3.

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

Transition options shape one iteration: its duration, and how its progress moves (`src/transition.ts`).

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

**Resolution** (`resolveTransition`) gives a `TransitionDescriptor`, `{duration, easing}`: the iteration's duration and its `Easing`, which depends on the kind. A spring's comes from `transitionDescriptorOf(spring, restDelta)`, which runs it until it rests. A timing resolves its transition as it's made (§2.6), so planning does none of it. The spring math behind a spring's easing belongs to the springs themselves (§4):
- **Eased:** the duration as given, and `resolveEasing(easing)`, or `linear` without one.
- **Springs:** the duration below, and a `SpringEasing` over it:

| Kind | Natural frequency ω₀ | Damping ratio ζ | Duration |
|---|---|---|---|
| Physical | √(k / m) | c / (2√(k·m)) | until it rests within `restDelta ?? PRECISION` |
| Visual | 2π / `visualDuration` | from `bounce` | until it rests within `PRECISION` |
| Duration | solved so it rests within `PRECISION` exactly at `duration` | from `bounce` | `duration` as given |

- **`bounce` to ζ,** as Apple's springs do: `bounce ≥ 0 ? 1 − bounce : 1 / (1 + bounce)`.
- **Equal transitions share one descriptor.** `resolveTransition` keys what it resolves by value: `filledTransitionOf` gives the transition's kind and every field with its default filled in (`mass` 1, `velocity` 0, `restDelta` `PRECISION`, `easing` `'linear'`), and its JSON is the key. So two timings with equal transitions, however they were written, share one easing and one spring, which spares the spring math and lets the spring fits cached per spring (§5.7) serve both. Equal springs given in different kinds aren't shared: they'd need to resolve to exactly the same numbers.
- **The cache is bounded.** It's a `LeastRecentlyUsedCache` (`src/utils/collections.ts`) of the 64 most recently resolved transitions (`maxResolvedTransitions`), so velocities that come from gestures, each a new key, don't grow it forever.
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
| `segment(start, end)` | A new easing of the part of the window between two offsets, running backwards when `end` comes first. |
| `reverse()` | A new easing of the window run backwards: `windowEnd` and `windowStart` swapped. |
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
    repeat?: number;            // iterations after the first
    repeatDelay?: Seconds;      // between iterations, never after the last
    repeatMode?: RepeatMode;
}

interface PlaybackOptions extends RepeatOptions {
    delay?: Seconds | Stagger;  // before the first iteration; not repeated
}

type Oscillation = 'time' | 'values';

interface RepeatDescriptor {
    repeatCount: number;        // iterations after the first; Infinity forever
    repeatDelay: Seconds;       // held before each repeat
    oscillate?: Oscillation;    // what every other iteration flips; none starts each repeat over
}
```

- **Animations take them.** Sequences have no playback options (§8).
- **What a timing keeps** (§2.6) is its `delay`, from `resolveDelay`, and its `repeat`, a `RepeatDescriptor` from `repeatDescriptorOf`.

| Option | Default | Rule |
|---|---|---|
| `delay` | 0 | A finite number, or a stagger. Negative becomes 0. |
| `repeat` | 0 | A number, and may be `Infinity`. Negative becomes 0, and fractions round down. |
| `repeatDelay` | 0 | A finite number. Negative becomes 0. |
| `repeatMode` | `'loop'` | One of the modes below. Any other throws a `TypeError`. |

| Mode | Every other iteration |
|---|---|
| `loop` | Runs forwards again. |
| `reverse` | Runs backwards in time, so its easing runs backwards too. |
| `mirror` | Flips the progress (`1 − progress`) and keeps the easing running forwards. This usually suits springs, because a spring played backwards starts wobbly and ends calm. |

- **`Infinity`** is a valid `repeat`.
- **Checks** (`src/playback-options.ts`): `checkDelay` and `checkRepeatOptions`, which `checkPlaybackOptions` runs together. `NaN` and infinite times throw through `checkNumber` (`src/utils/validation.ts`).
- **The delay a timing keeps** is `resolveDelay(delay)`: 0 without one, a negative number 0, and a stagger wrapped by `checkedStaggerOf` (§2.5).
- **The repeats a timing keeps** are `repeatDescriptorOf(iterationDuration, options)`, read from the options once `clampedRepeats` has clamped them: `repeat` is the count, `reverse` flips `'time'`, `mirror` flips `'values'`, and `loop` has no `oscillate`. A timing without duration, or without repeats, gets a `repeatCount` and `repeatDelay` of 0 and no `oscillate`.
- **`clampedDelay` and `clampedRepeats`** clamp an options object as it is. `TimedTweenTiming` uses them directly (§2.6).

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

**`checkedStaggerOf(stagger)`** (`src/playback-options.ts`) wraps a stagger so each delay that's `NaN` or infinite throws (`The staggered delay of element <index> …`), and a negative one becomes 0. The wrapper keeps the stagger's `from`. Timings keep their stagger wrapped this way, as their `delay` (§2.4). The plan calls it with each element's index and the element count.

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

    readonly duration: Seconds;          // one iteration, without delays or repeats
    readonly easing: Easing;             // the easing one iteration runs
    readonly delay: Seconds | Stagger;   // clamped, with a stagger wrapped
    readonly repeat: RepeatDescriptor;
}

type AnimationTimingOptions = TransitionOptions & PlaybackOptions;
```

- **One run through the transition,** with its delay and repeats (`src/animation-timing.ts`).
- **`of` is the only way to make one.** The constructor is private. It validates the transition and options, then resolves them.
- **A timing resolves as it's made.** Its `duration` and `easing` come from `resolveTransition` (§2.2), its `delay` from `resolveDelay`, and its `repeat` from `repeatDescriptorOf` with its duration (§2.4). It keeps none of the options as given, so planning only reads what it resolved.
- **Its fields are public.** The types they show, `Easing` and `RepeatDescriptor`, aren't exported from the package.
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
- **Entry paths** (`EntryPath`, `naming.entryPathOf`) are the names leading to an entry, joined by `>`. The definitions and the adapter name entries by them.
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

**Resolving.** `resolvePosition(descriptor, referenceSpans, selfDuration)`:
- `referenceSpans` maps the earlier entries' names to `Span`s, `{start, duration}`, in order, so its last entry is the previous one. With none, the previous entry is `{start: 0, duration: 0}`.
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
| **Reference duration** | From the start to where the entry ends. An infinite repeat counts only its first iteration, since infinity can't be referred to. An entry with no elements has 0.<br>• **An animation's:** its latest staggered delay, then its iterations and their repeat delays, as its `RepeatDescriptor` gives them, so one without duration counts no repeat delays.<br>• **A sequence's:** until the latest end among its entries. |
| **End** | The start plus the reference duration. References to an entry's end resolve to it. |
| **Duration** | For positions, an entry's `Span` runs from its start for its reference duration. The inserted entry's doesn't depend on its position, so it's known before the entry is placed. |
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

- **`TweenStops`** (`src/tween-stops.ts`) are one property's stops, in order of offset, with a stop at each end. `TweenStops.of(property, rawStops)` turns a form into them: a form that isn't one value, a list or a keyed object throws a `TypeError`, and so does a value that isn't a number, a string or `null`; keys outside 0–1 throw a `RangeError`, a `null` between the ends is left out, and a form left without values throws a `TypeError`. Its constructor is private, so every instance is one `of` checked.
    - **The ends:** a missing or `null` 0 or 1 becomes a stop whose value is `null`, which stands for the value underneath: as the entry starts at 0, and as it ends at 1.
    - The values stay as given, numbers or CSS text, and `null` for a missing one, through the plan and the tracks (§5.4). The native effects stage resolves them (§5.5, §5.6).
- **When the forms are checked:** as the definition is made. An `AnimationDefinition` makes `TweenStops` of every property and keeps them as `stopsByProperty`: in `animation()`, in an inline sequence entry, and for every animation entry of a mapping given to `sequence()`. Playing reads those, and never meets an invalid form.
- **A missing 0** is the **value underneath** as the entry starts: the value of the topmost of the entries under it on its track that has one there, one that runs there, at its value then, or one that holds its end or start value there (§5.5). With none, it's the property's current value when `animate` is called (§5.6).
- **A missing 1** is the value underneath as the entry ends, by the same rule. An entry after it never gives one. One that repeats forever never ends, so its missing end is what's held under it once everything under it is done, or the current value.
- **In a repeating sequence,** the entries under an entry in the sequence come first, then what's under the sequence on its track (§5.5).
- **Between stops,** the value is linear in the progress. Past the ends, as a spring overshoots, it continues the nearest segment.
- **Properties** are camelCase. Custom properties are written as they are (`--like-this`). `float` and `offset` become `cssFloat` and `cssOffset` in keyframes (§5.8).
- **Value types and units** come from `CSS.supports`, per property (§5.2).
- **Passing through or resolving to numbers:** a keyframe that lands on a stop passes its value through to WAAPI as its CSS text. A keyframe between two stops takes a number between theirs, in the unit they come to (§5.6). Where that's needed, a property must take a single number: `transform` and two-value `translate` aren't supported there.

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
    1. names the unnamed entries in order, as `a` to `z`, then `aa`, `ab` and on (`naming.defaultEntryNameOf`), skipping the names given;
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

When entries animate the same property of the same element (§5.4):

- Entries stay apart, each with its own repeats, whether they overlap or not. The one that starts later shows over the earlier ones while it runs, and they show again once it ends, from where they are by then. When they start together, the one declared later shows over the other.
- Entries whose ends only touch don't overlap.
- Only the entries that start first hold their start values before they start.
- An entry holds its end values after it ends, unless an entry under it that shows runs on after that.
- An entry that one over it covers from its start to its end never shows.
- Entries that a sequence around them repeats stay together, as a group that repeats as the sequence does, since a repeat plays all of them again together (§5.4). Sequences don't repeat yet (§8).

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
- **Each `animate`** plans the definition, which resolves its targets in the scope, then resolves the tracks, with their values per element, and calls `element.animate()` for each effect (§5). A definition with no plan, because nothing in it has targets, gives controls over no animations.
- **What a definition holds:** an `AnimationDefinition` its `timing` (an `AnimationTiming`), `target` and `stopsByProperty` (a `TweenStops` per property, §3.4); a `SequenceDefinition` its `entries` and its `timing` (a `SequenceTiming`).
- **`SequenceDefinitionEntries`** (`src/sequence.ts`) are one ordered array, in the order of the timing's entries, as `SequenceTimingEntries` are (§2.7). Each is `{name, animation}` (`AnimationDefinitionEntry`, with an `AnimationDefinition`) or `{name, sequence}` (`SubsequenceDefinitionEntry`, with a `SequenceDefinition`), so every leaf is an `AnimationDefinition`. Positions stay in the timing.
- **Definitions expose nothing.** Their fields are `@internal`, and so is `AnimationDefinition`'s constructor; `SequenceDefinition`'s is private (§3.5). Besides `SequenceDefinition.of`, they have no methods: animators read their fields.
- **It always starts playing.** There's no `autoplay`: pausing right after `animate` shows no motion, because no frame renders in between.
- **Animation `id`s** are the track entry's name and the property, `name:property`, or the property alone for an animation on its own. An item is named by its leaf's path, the entry names leading to the leaf joined by `>` (§2.7); a repeating sequence's group by its leaves' paths joined by `+` (§5.4).

### 3.8 Controls

`AnimationControls` (`src/waapi/controls.ts`) wraps the native `Animation`s of one `animate` call.

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
    2. read the current time and find the active segment's stops, easing and window;
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
| Timing | `AnimationTimingOptions`, `PlaybackOptions`, `RepeatOptions`, `RepeatMode`, `Stagger`, `StaggerSpacing`, `StaggerOptions`, `StaggerOrigin` |
| Sequence entries and positions | `SequenceTimingEntries`, `SequenceTimingEntry`, `AnimationTimingEntry`, `SubsequenceTimingEntry`, `At`, `PositionDescriptor`, `PositionReference`, `PositionAnchor`, `PositionOffset` |
| Transitions | `TransitionOptions`, `EasedTransitionOptions`, `SpringTransitionOptions`, `DurationSpringTransitionOptions`, `VisualSpringTransitionOptions`, `PhysicalSpringTransitionOptions` |
| Easings | `EasingSpecifier`, `EasingPreset`, `CubicBezierEasingParams`, `StepsEasingParams`, `StepPosition` |
| Units | `Seconds`, `Progress` |

### 3.10 Errors

Every error has the type of what went wrong:

| Type | Thrown for | Examples |
|---|---|---|
| `RangeError` | A number out of range | a negative duration, `NaN` or an infinite time, a `bounce` outside −1–1, a value key outside 0–1, a steps count below 1, a cubic Bézier `x` outside 0–1 |
| `TypeError` | An input of the wrong shape or kind | a transition missing a required key or mixing kinds, an easing that isn't a preset or params, a value form or value of the wrong type, an unknown `repeatMode`, `step` with `spread`, no values, a missing mapping entry or one that isn't `[target, values]`, a value the property doesn't take, a sequence timing or definition, or either's builder, constructed directly |
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
| `src/transition.ts` | Transition options: their kinds, their keys, telling them apart, checking them, and resolving them into a `TransitionDescriptor`, cached by value |
| `src/playback-options.ts` | `PlaybackOptions`, `RepeatOptions`, `RepeatMode`, `Stagger`, `RepeatDescriptor` and `Oscillation`, their checks and their clamps, `checkedStaggerOf`, `resolveDelay` and `repeatDescriptorOf` |
| `src/stagger.ts` | The `stagger` utility, `StaggerSpacing`, `StaggerOptions` and `StaggerOrigin` |
| `src/animation-timing.ts` | `AnimationTiming`, `AnimationTimingOptions` and `TimedTweenTiming`, with validation, and an animation timing's transition, delay and repeats resolved |
| `src/at.ts` | `At`, `PositionDescriptor`, `parsePositionDescriptor`, `checkPositionDescriptor` and `resolvePosition` |
| `src/sequence-timing.ts` | `SequenceTimingBuilder`, `SequenceTiming` and its entries, with validation |
| `src/naming.ts` | `Naming` and `naming`: every naming rule. The names unnamed entries take, entry paths (`EntryPath`), track entry names (`trackItemNameOf`, `trackGroupNameOf`), and native animation ids |
| `src/tween-stops.ts` | `TweenStops`: one property's stops, read from their forms and checked, with a stop at each end |
| `src/animation.ts` | `animation` and `AnimationDefinition` |
| `src/sequence.ts` | `sequence`, `SequenceDefinition`, `SequenceDefinitionBuilder`, its entries, `Definition` and `EntryPlacementOptions`, and making a sequence timing's entries' definitions from its mapping |
| `src/plan.ts` | `plan`, through `AnimationPlanner` and `SequencePlanner`: the plan tree of starts, durations and repeats, with each animation's targets and where it starts on each, `RepeatDescriptor` and `Oscillation` |
| `src/animator.ts` | The `Animator` abstract class, which turns `animate`'s forms into a definition for the engine's `animateDefinition` |
| `src/internals.ts` | The internals `site/` uses, which it imports as `timesfps/internals`; `tsconfig.json` leaves it out of the build |
| `src/utils/validation.ts` | `checkNumber`, `checkPositive`, `requireNumber` and `requireProperty` |
| `src/utils/environment.ts` | `isProduction`: whether a bundler built it for production, from `process.env.NODE_ENV`; false where `process` doesn't exist |
| `src/utils/math.ts` | Interpolation and solving monotone functions |
| `src/utils/records.ts` | Reading numeric-keyed records in order |
| `src/utils/collections.ts` | `groupBy`, `getOrInsertComputed`, `partitionPoint` (binary search for the first item past a point), and `LeastRecentlyUsedCache` |
| `src/tracks/track-entries.ts` | `TrackEntry`, with `repeats` and `repeatsForever`, `TrackStop`, and a track's entries, `TrackItem` and `TrackGroup`, with `timeAtOffset`: an entry's run, its stops, `null` for a missing value, and what the tracks stage gives |
| `src/tracks/track-entry-builder.ts` | `TrackEntryBuilder`, and the builders that extend it, `TrackItemBuilder` and `TrackGroupBuilder`: a track's entry built step by step, an item entry's run through its stops, or a repeating sequence's run with the builders of the entries in it |
| `src/tracks/track-layering.ts` | `dropCoveredEntries`: the builders that show once laid over each other, through the internal `layOver`, which leaves out the builders that one laid over them covers, and `resolveHolds`: which of builders that show hold before and after them, the first one before them only with `firstHoldsBefore` |
| `src/tracks/tracks.ts` | `TracksResolver`, its `TrackBuilder`s, which hold a track's entries (`TrackItemEntry`) in the groups of the sequences around them (`TrackGroupEntry`) and build them into its entries, the `Tracks` it gives, and `Track`: the engine-agnostic tracks stage |
| `src/dom/mapping.ts` | What binds a timing to the DOM, for any DOM adapter: targets, value forms (`RawTweenStops`), mapping types, `AnimatorOptions`, resolving targets, and `ByElementAndProperty`, a value for each property of each element, with `mapByElementAndProperty` |
| `src/waapi/animator.ts` | `animator`, and `WAAPIAnimator`, the `Animator` for WAAPI, which runs every step and creates the native animations |
| `src/waapi/controls.ts` | `AnimationControls`: playing, pausing, seeking and listening to the native animations together |
| `src/waapi/css-values.ts` | CSS property names, value types, and values on the page: `CurrentValueProvider`, `checkedTextOf` and `alignedNumbersOf` |
| `src/waapi/native-effects.ts` | `NativeEffectsResolver` and the `NativeEffects` it gives: tracks into WAAPI effects, each entry resolved (the internal `UnresolvedTrackEntry`) into a resolved track entry, and the holds WAAPI plays |
| `src/waapi/missing-values.ts` | `resolveMissingValues`, `MissingValuesUnresolvedEntry` and `MissingValuesResolvedEntry`: the value underneath each missing value of entries laid over each other, as a pure algorithm on those two interfaces |
| `src/waapi/native-effect-scale.ts` | `NativeEffectScale` and `ScaleStop`: one property's values on one element at offsets of an easing's progress, as CSS text |
| `src/waapi/resolved-track-entries.ts` | `ResolvedTrackItem` and `ResolvedTrackGroup`: track entries with their missing values resolved, their values at a time, and their iterations as plays, a group's flattened, since WAAPI can't nest repeats |
| `src/waapi/native-effect-builder.ts` | `NativeEffectBuilder` and `NativeEffect`: a resolved track entry into its effects, natively repeated or laid out in keyframes |
| `src/waapi/keyframes.ts` | `easingAndKeyframesOf` and `NativeKeyframe`: plays into native keyframes and easings |
| `src/waapi/native-easing.ts` | `NativeEasing` and its CSS form |
| `src/waapi/spring-fit.ts` | Fitting a spring easing with cubic Bézier segments |

Relative imports end in `.ts`, and `rewriteRelativeImportExtensions` makes the build emit `.js`. Turbopack doesn't map `.js` imports to `.ts` files, so this is what lets the site load the source.

`site/` is the demo site. Its `tsconfig.json` aliases `timesfps` to `src/index.ts` and `timesfps/internals` to `src/internals.ts`, so it runs the library's source with one copy of every class, which the library's `instanceof` checks need. Its spring page checks spring fits by eye: the fitted spline, and the keyframes the adapter plays, each against the spring.

## 5. Adaptation flow

```
new WAAPIAnimator({scope}).animate(definition)    scope: document.documentElement by default
│
├─ 1. Plan         plan(definition, targetsResolver)  → AnimationPlan | SequencePlan tree, or undefined: nothing plays
│                  (targets resolved §5.1, starts and delays §5.3; values stay as given §5.2)
├─ 2. Tracks       new TracksResolver(plan, naming).resolve()  → Tracks: a Track per target and property (§5.4)
│                  (entries layered, repeating sequences kept as groups, holds; missing values left as null)
├─ 3. Effects      NativeEffectsResolver.resolve(tracks), per track (§5.5)
│     ├─ a. missing values  resolveMissingValues: each entry, in stacking order, takes the value underneath
│     │                     each of its missing ones, its values a NativeEffectScale (§5.6)
│     │                     → (ResolvedTrackItem | ResolvedTrackGroup)[]  (a group's iteration flattened into plays)
│     └─ b. effects         new NativeEffectBuilder(entry).build() → NativeEffect[]  (repeats as iterations or keyframes,
│                           fills §5.5; keyframes and native easings §5.7)
│                  = NativeEffects: ByElementAndProperty<NativeEffect[]>
└─ 4. Play         element.animate(...) per effect
                   → AnimationControls
```

The plan walks the definition tree, which holds every target and value, so nothing is looked up by path. Every animation leaf is still named by its **entry path**: the names leading to it joined by `>`, such as `intro>logo>fade`. Names can't contain `>`, so paths can't collide. The tracks stage builds the paths as it walks the plan, and names each entry of a track by them (§5.4), which names the animations (§5.8).

### 5.1 Targets

The plan resolves each animation definition's target as it reaches it, through the `TargetsResolver` it's given. The animator's resolves each target once per `animate`, however many times a sequence plays it, through `resolveTargets` (§3.3): a selector is queried in the scope, and a function is called with it. Elements are deduplicated. An animation with no elements has a reference duration of 0, so it starts and ends at its position, and the entries after it are placed against that, but it has no plan (§5.3).

### 5.2 Values

Values stay as given, numbers or CSS text, in each definition's `TweenStops`, through the plan and the tracks, which leave a missing one as `null` (§5.4). The native effects stage resolves them per track, so per element, because units like `em`, `%` and `vw` depend on the element, and so does the current value a missing one may take (§5.5, §5.6). There, each item's values become a `NativeEffectScale`, which turns a bare number into CSS text with the property's default unit, and resolves values to numbers where they need to be.

A property's **value type** comes from `CSS.supports`, tested against `1`, `1px`, `1%`, `1deg` and `1s`, and cached per property. It's only looked up for a bare number, or to resolve a value. It gives:
- the **default unit** for a bare number: none when the property takes numbers, then `px`, then `deg`; otherwise a bare number throws;
- the **probe syntax**, such as `<length-percentage>` or `<number> | <percentage>`.

Nothing is resolved in place, and no stage before the native effects one works a value out: a track's stops (`TrackStop`) hold given values, and `null` for a missing one. The native effects stage gives each missing value its value underneath, as CSS text, before it builds anything that needs it, and each item's scale works its given values' texts out once (§5.6).

### 5.3 Plan

`plan(definition, targetsResolver)` (`src/plan.ts`) places the definition in time, through the internal `AnimationPlanner` and `SequencePlanner`. It returns a tree with the definition's levels, an `AnimationPlan` for each animation and a `SequencePlan` for each sequence, holding what playing it needs, or `undefined` when nothing in the definition has targets. Positions are resolved within each sequence (§2.7), but every time the plan gives is after the outermost definition starts.

| Field | Meaning |
|---|---|
| `type` | `'animation'` or `'sequence'` |
| `stopsByProperty` | An animation's only: its definition's `TweenStops`, by property |
| `entries` | A sequence's: each entry's node, by name, in order |
| `start` | Where the entry starts, before its delay: its sequence's `start` plus its position, 0 for the outermost definition. What `<` refers to |
| `iterationDuration` | One iteration of an animation, its timing's `duration`, without delays or repeats. A sequence's runs from 0 to the latest end among its entries, gaps included |
| `easing` | An animation's only: its timing's `easing` (§2.2) |
| `repeatCount` | The iterations after the first, `Infinity` forever |
| `repeatDelay` | How long it holds its end value before each repeat, in seconds |
| `oscillate` | What every other iteration flips (`Oscillation`): `'time'`, so it plays backwards, or `'values'`, so it runs from the end values to the start ones with its easing forwards. Without it, every repeat starts over |

Leaves also keep `targets` (`StaggeredTarget`): each element as `target`, with the `start` of the animation on it, the entry's `start` plus the animation's own delay for it (its number, or its stagger at the element's index).

**Repeats.** An animation's plan copies its timing's `RepeatDescriptor` (§2.4). A sequence doesn't repeat until sequences can; tests give repeating ones their repeats (§7).

**Entries without targets.** An animation without targets has no plan, and a sequence has none when none of its entries has one, at any depth. A sequence's plan leaves out the entries that have none. They still keep their positions, so the entries after them are placed as before, and the sequence's iteration duration still runs to their ends.

**Planning in steps.** Each planner plans one entry, once:
1. `of(definition, targetsResolver)` takes everything that doesn't depend on where the entry sits. An `AnimationPlanner` resolves the targets, each target's own delay, and the reference duration, and keeps the timing, whose duration, easing and repeats are already resolved. A `SequencePlanner` makes and positions the planners of its whole subtree, as below.
2. `position(descriptor, referenceSpans)` resolves the position among the entries before it, within its sequence, clamped to 0. A `=%` offset reads the planner's own reference duration, which is already known.
3. `plan(sequenceStart)` gives the node, or `undefined` when it has none, its `start` its position after `sequenceStart`, where its sequence starts (0 for the outermost definition). Where a sequence starts is only known once it's positioned in the one around it, which happens after its own `of`, so this is the step that turns positions into starts.

The reference duration (§2.7.2) stays in the planners: only placing the entries after an entry and working out its sequence's durations need it, and both happen while planning. It reads the timing's `RepeatDescriptor` (`calcReferenceDuration`), so it always agrees with the repeats the plan gives.

`SequencePlanner.of` makes a planner for each entry, positions it and keeps its `referenceSpan` for the positions after it. A sequence's iteration duration and reference duration are both the latest end among its entries. Its `plan(sequenceStart)` plans each entry from its own `start`, and keeps the ones that have a plan.

### 5.4 Tracks

`TracksResolver` (`src/tracks/tracks.ts`) lays every animation leaf out in time, per target and property. It knows nothing of the engine: tracks hold entries, items and the groups of repeating sequences, whose runs say what happens rather than how a definition asked for it, and the WAAPI side decides how to play them, merging each group into one native effect builder, since it can't nest repeats (§5.5). The tracks stage merges nothing, and leaves missing values as `null`: what shows under an entry at a time depends on how the stage that plays the tracks plays them.

```
new TracksResolver(plan, naming).resolve()
├─ 1. Walk the plan     each sequence → a group in every TrackBuilder (startGroup … endGroup),
│                       each leaf → a TrackItemEntry in the TrackBuilder of each of its targets × properties
└─ 2. TrackBuilder.build(), per track
      ├─ a. Build         the entries' builders: an item entry's own, a group's that doesn't repeat in its place,
      │                   a repeating group's own, with its entries' builders in it; sorted, each group's continuations right before it
      └─ b. Layer         dropCoveredEntries(builders): the ones that show; resolveHolds(showing);
                          each → TrackItem | TrackGroup, missing values left as null
→ Tracks: ByElementAndProperty<Track>
```

**1. Walk the plan.** Entries are added to their `TrackBuilder` in declaration order, which keeps them in that order. `TracksResolver` gives every `TrackBuilder` its `naming`.
- **Runs.** A `TrackEntry` (`src/tracks/track-entries.ts`) is the run every entry of a track has:
  - `start`, after the outermost definition starts, and `iterationDuration`, as the plan gives it;
  - `repeatCount`, `repeatDelay` and `oscillate`: `TrackEntry` extends the plan's `RepeatDescriptor`, and takes them as the plan gives them (§5.3).
- Each part of the resolver that takes a plan makes its runs from it itself, so nothing else is given a whole plan only for its run: the resolver's `startGroup` from a `SequencePlan`, and `addAnimation` from an `AnimationPlan`.
- Each sequence gets a run from its plan's `start`.
- **Groups.** `addSequence` gives the resolver's `startGroup` the sequence's plan, which starts a group of the sequence's run in every track builder (their `startGroup`); it then adds the sequence's entries, and ends the group (`endGroup`). The resolver keeps the runs of the groups started (`startedGroups`), and a track builder made while they are starts them too. So every track builder has a group of every sequence, whether or not anything in it is on its track.
- Each leaf adds a `TrackItemEntry` per target and property, a `TrackEntry` with:
  - `start`: where the animation starts on the target, from the plan's `targets`;
  - `iterationDuration` and its repeats from its own plan, and its `easing` and `stops`;
  - `path`: its entry path (`naming.entryPathOf`).

**Track builders** (`TrackBuilder`, `src/tracks/tracks.ts`) hold a track's entries in the groups of the sequences around them:

| Part | What it does |
|---|---|
| `rootEntries` | The entries outside every group |
| `groups` | The groups started and not yet ended, the outermost first, each a `TrackGroupEntry`: a sequence's run, with the `entries` in it, in their order |
| `activeEntries` | The entries of the group started last, or `rootEntries` without one |
| `startGroup(parentTiming)` | Pushes a group of the run onto `groups` |
| `add(entry)` | Pushes an item entry onto the active entries |
| `endGroup()` | Pops the group started last, and pushes it onto the active entries, as an entry of the group around it. Without a group started, it throws |
| `build()` | Ends every group still started, then builds the track (2a, 2b) |

Once built, a track builder is closed: `startGroup`, `add`, `endGroup` and `build` throw.

**2a. Build** (`TrackBuilder.build`). Turns the root entries into builders (`buildersOf`), in declaration order:
- **An item entry** (an infinite one included): a builder of its run with its own repeats (`TrackItemBuilder.of`). WAAPI shows a later effect over an earlier one, and the earlier one again once it ends, so items never join into one.
- **A group that doesn't repeat:** its entries' builders, in its place. It only shifts them in time, so the track doesn't keep it.
- **A repeating group** (`repeats`: its `repeatCount` is above 0): a builder of its own, with its continuations (`groupBuilderOf`, below).

Then it sorts them by start (`byStart`), ties in declaration order (the sort is stable). This is the stacking order: a builder shows over the ones before it. A final pass puts each repeating group's continuations right before it, from a `ContinuationsByBuilder` map, so they're under it, and passes them all to `dropCoveredEntries` in that order.

**A repeating group's builder** (`groupBuilderOf`). A repeat plays everything in the sequence again together, so the track keeps the sequence as a group: its run, and its entries as they play in its first iteration. A repeating group in it stays a group, with its own repeats.
- **Builders:** its entries' builders (`buildersOf`), sorted by start. A repeating group in it gets its builder first, by recursion.
- **Repeating forever:** a builder that repeats forever plays once in each iteration, through `withoutRepeats()`, a copy of it without repeats, which is only made for those (`builder.ends ? builder : builder.withoutRepeats()`). Every other builder keeps its repeats.
- **Layering** (`dropCoveredEntries`, 2b). The builders are laid over each other as a track's are, in the group's first iteration, so one that a later one covers is left out.
- **Holds** (`resolveHolds(showing, {firstHoldsBefore: false})`). The ones that show hold after as a track's do, and none of them holds before. An entry's hold after shows until what's next in the group does, across the repeat delay and into the next iteration too.
- **Its builder** (`TrackGroupBuilder.of`): the group's run, its `entries` left out, with the builders that show, named from the paths of the item entries in it at any depth, by start (`itemEntriesIn`, `nameOf`).
- **Continuations**, against the group's builder in the map: the outermost builders in it, at any depth, that repeat forever: each of its builders that does, and the continuations of each that ends, sorted by start. Nothing around them repeats forever, so they carry on under the group once that ends. Each is the builder that repeats forever itself, so it's named after what it continues. Its values are its own: the native effects stage gives its missing values from what's under it on the track, as any entry's, whatever its copy in the group takes (§5.5). A group that repeats forever itself has none, since it never ends.
- A group without item entries in it, at any depth, has no builder.

**2b. Layer** (`src/tracks/track-layering.ts`). `dropCoveredEntries(builders)` lays builders over each other in the order they're given, each over the ones before it, and returns the ones that show, in that order (`builders.reduce(layOver, [])`). Each leaves out the ones under it that it covers: they never show. It never sorts and knows nothing of continuations, so any order works. A builder **runs at** a time from its start up to, but not at, its end (`TrackEntryBuilder.runsAt`), and **covers** another when it starts with or before it and ends with or after it (`TrackEntryBuilder.covers`).

`TrackBuilder.build` then gives the ones that show their holds and builds them:
1. **Holds** (`resolveHolds(builders)`). The topmost of the ones that start first holds before it starts; with none showing, none does. With `firstHoldsBefore: false`, which a repeating group's builder passes for its entries, none does. One that ends holds after it, when none under it runs at its end.
2. **Entries.** The ones that show build, in the order they're given, each into a `TrackItem` or a `TrackGroup` (below).

**Entry builders** (`src/tracks/track-entry-builder.ts`). Layering and holds work with a `TrackEntryBuilder`, which two builders extend. They know nothing of values:
- **`TrackItemBuilder`:** an item entry's run through its stops, by its easing. `TrackItemBuilder.of(name, timing, easing, stops)` makes one from its `TweenStops`, whose stops it keeps as they are, `null`s included.
- **`TrackGroupBuilder`:** a repeating sequence's run, with the builders of the entries in it as they play in its first iteration, laid over each other, all of which show, with their holds. `TrackGroupBuilder.of(name, timing, entries)` throws without entries, or when one of them never ends, saying to give the group that entry without its repeats.

Each has a name and a `TrackEntry`, and builds one entry of the track.

| Part | What it does |
|---|---|
| `start`, `end`, `ends` | When it starts and its last iteration ends, and whether it ends. `end` is `Infinity` when it repeats forever. A group starts where its first entry does, and ends where its entries end in its last iteration, mirrored when that iteration flips |
| `runsAt(time)`, `covers(other)` | Whether it runs at `time`, from its start up to, but not at, its end, and whether it starts with or before `other` and ends with or after it |
| `withoutRepeats()` | A builder of its first iteration only, without repeats or oscillation, with the same stops |
| `holdsBefore`, `holdsAfter`, `holdBefore()`, `holdAfter()` | Whether it holds its start value before it, or its end value after it, and making it |
| `build()` | Its entry of the track, a `TrackItem` or a `TrackGroup` (below), with its holds |

**The track's entries** (`src/tracks/track-entries.ts`). A `Track` (`src/tracks/tracks.ts`) is its entries in stacking order, each a `TrackItem` or a `TrackGroup`. Next to `TrackEntry`, `repeats(timing)` and `repeatsForever(timing)` say whether a run repeats, and whether it repeats forever; `TrackEntryBuilder` and `TrackBuilder` use them.

A `TrackStop` is a value at an offset of an easing's progress: a given value, or `null` for a missing one. `timeAtOffset(item, offset)` is the time `offset` of the way from an item's start to its end: its start at 0, and its end at 1, `Infinity` for one that repeats forever.

| Field | Meaning |
|---|---|
| `type` | `'item'` or `'group'` |
| `name` | From the `Naming`: an item's entry path, or the paths of a group's leaves joined with `+`, such as `intro>title+intro>subtitle`. A continuation is named after what it continues. An animation on its own has none |
| `start`, `iterationDuration`, `repeatCount`, `repeatDelay`, `oscillate` | Its run (`TrackEntry`). A group's are its sequence's |
| `end` | When its last iteration ends, `Infinity` when it never ends, as its builder works it out: a group's where its entries end in its last iteration |
| `easing`, `stops` | An item's: its easing, and its stops, as given, `null` for a missing value |
| `entries` | A group's: its entries as they play in its first iteration, in stacking order, none of them holding before. Each of its iterations plays them, and every other one of an oscillation flips them |
| `holdsBefore` | Whether it holds its start value before it starts |
| `holdsAfter` | Whether it holds its end value once it's done, after its last repeat; in a group, until what's next in it shows |

### 5.5 Effects: missing values, resolved entries and native effects

`NativeEffectsResolver.resolve(tracks)` (`src/waapi/native-effects.ts`) is the whole native effects stage: it takes nothing but the tracks, and reads the page itself. It turns each track into WAAPI effects:
1. **Missing values:** each entry as an `UnresolvedTrackEntry`, resolved in stacking order (`resolveMissingValues`, below), with the property's current value under them all (`CurrentValueProvider`, §5.6). Each resolves into a `ResolvedTrackItem` or a `ResolvedTrackGroup`.
2. **Holds:** the ones WAAPI can play are checked (`requireOnlyFirstHoldsBefore`, below).
3. **Effects:** each resolved entry builds into its effects (`new NativeEffectBuilder(entry).build()`), in the track's order.

**Missing values** (`src/waapi/missing-values.ts`). `resolveMissingValues(entries, valueUnderneath)` is a pure algorithm on two interfaces. It knows nothing of tracks, resolved entries or the form values are kept in:

| Part | What it is |
|---|---|
| `MissingValuesUnresolvedEntry<Value, Resolved>` | An entry whose missing values are yet to be resolved. `resolve(valueUnderneath)` gives it resolved, each missing value taking `valueUnderneath`'s value at its time |
| `MissingValuesResolvedEntry<Value>` | An entry whose missing values are resolved. `valueAt(time)` gives its value while it runs, or where it holds its value, and `undefined` elsewhere |

It resolves the entries in the order they're given, each over the ones before it, and returns them resolved, in that order. The lookup each entry gets gives, at a time:
1. the value of the topmost of the ones resolved before it that has one there (`topmostValueAt`);
2. with none, the value its own `valueUnderneath` gives.

That's the **value underneath**: what WAAPI shows there, the topmost effect that's running or filling. Values only come from below, so each entry resolves from ones already resolved: there are no cycles, nothing waits, and nothing is taken from an entry over it or after it.

**Unresolved entries** (`UnresolvedTrackEntry`, internal to `src/waapi/native-effects.ts`) keep a track entry and a `nativeEffectScaleFactory`, which makes a scale of the track's property on its element from resolved stops (`ScaleStop`s), and resolve into a resolved entry:
- **An item:** its stops, each missing one taking the value underneath at its time (`resolvedStopsOf`, `timeAtOffset`): a missing start where the item starts, and a missing end where it ends, at `Infinity` for one that repeats forever, where only what's held under it gives a value. They become its scale, which checks its given values (§5.6), and the item a `ResolvedTrackItem`.
- **A group:** its entries resolve among themselves (`resolveMissingValues`), in its first iteration, with the value underneath the group as their fallback: the entries under it on the track, then the current value. They become a `ResolvedTrackGroup` (`ResolvedTrackGroup.of`).
- **A continuation** is an entry like any other: its missing values come from what's under it on the track, whatever its copy in the group takes.

**Resolved entries** (`src/waapi/resolved-track-entries.ts`). Both implement `MissingValuesResolvedEntry<string>`, and have their track entry's fields but `type`: its name, run, `end` and holds. A **play** is a `ResolvedTrackItem` that plays once, without holds: one iteration of an item, or a part of one. Times are after the outermost definition starts.

| Part | What it does |
|---|---|
| `ResolvedTrackItem.of(item, scale)` | The item, with its values as `scale` in place of its stops, and its `easing` |
| `ResolvedTrackGroup.of(group, entries)` | The group, with its entries resolved, its first iteration flattened into plays (below). It throws without entries, for an entry that holds before, and for one that repeats forever |
| `ends` | Whether it ends: it doesn't when it repeats forever |
| `valueAt(time)` | Before it starts, its start value when it holds before; from its end on, its end value when it holds after; `undefined` otherwise. In between, `clampedValueAt(time)`. A group starts where what plays in its first iteration does |
| `clampedValueAt(time)` | Its value at `time` as though it held before and after: its iteration's then, at its scale's value at its easing's progress there. A repeat delay, and the time before what plays in a group's iteration starts, show the end value of the iteration before |
| `plays(first, last)` | Its iterations from `first` to `last` as plays, one after another, each one's end value held until the next starts (`joined`). An item's iteration is one play, every other one of an oscillation flipped; a group's is its first iteration's plays, moved to where the iteration starts, and every other one of an oscillation back to front, each play flipped and moved to the mirror image of its time in the iteration |
| `startValue`, `endValue` | An item's: the value its first iteration starts on, and its last ends on. `endValue` throws for one that never ends |
| `moveTo(start)` | A play's: the same play from `start` |
| `trim(start, end)` | A play's: what of it runs from `start` to `end`, its easing's window narrowed to that (`Easing.segment`); its scale stays. A jump stays when it's from `start` up to, but not at, `end` |
| `flip(oscillate)` | A play's: the same play, in the same time, with what `oscillate` flips flipped. Flipping its `'time'` runs its easing backwards (`Easing.reverse`). Flipping its `'values'` flips its scale and runs it through the mirror image of its easing's window, from 1 minus its end to 1 minus its start, forwards: at a fraction `x` of an iteration, it reads `1 − p(1 − x)`, so its values run from end to start, however it's trimmed |
| `holdEnd(until)` | A play's: its end value held from its end until `until`, a play through a linear easing of a scale held at its end progress (`NativeEffectScale.heldAt`); `undefined` when there's no time to hold it |

`moveTo`, `trim`, `flip` and `holdEnd` throw for an item that repeats or holds, saying to take its plays first.

**Flattening a group** (`ResolvedTrackGroup.of`). WAAPI can't nest repeats, so a group plays its entries in one iteration:
1. Each entry's iterations, one after another (`plays(0, repeatCount)`), a group in it flattened first, as it resolved.
2. Laid, after the first, against the plays so far, in stacking order:
    - **Starts before they end** (a shared start included): it replaces their plays while it lasts (`overlay`). A play it trims (`trimmed`, `trim`) keeps its scale, and only its easing's window narrows, so its values are the ones it had there.
    - **Starts at or after their end:** it follows, with their end value held until then (`joined`), as the holds the tracks stage gives its entries say.

**Holds it plays.** An entry's hold before would show over every effect under it that starts earlier, and playing it only once those end would take merging them. So the resolver throws for an entry that holds before and starts after another (`requireOnlyFirstHoldsBefore`), and `ResolvedTrackGroup.of` for an entry of a group that holds before. The tracks stage gives neither.

**Native effect builders** (`src/waapi/native-effect-builder.ts`). `new NativeEffectBuilder(entry).build()` gives a resolved entry's effects (native layout, below), each one a stretch of its iterations (`stretch(first, last, {holdsUntilNext})`): its plays from `first` to `last`, from where the first one starts to where the last one ends. With `holdsUntilNext`, the last one's end value is held too, until the iteration after it would start. It throws for iterations the entry doesn't have.

**Native layout** (`build`). For an entry whose iteration's plays go from `a` to `b`, in iterations of `L` with a repeat delay `d`, the period is `P = L + d`:

| Case | Effects |
|---|---|
| No repeat | the iteration |
| No repeat delay, not oscillating in values, the iteration fills it | the iteration × playCount, `alternate` when it oscillates in time |
| Not oscillating | [iteration + hold to `a + P`] × repeatCount, then the last iteration on its own; × ∞ alone when infinite |
| Oscillating, infinite | [iteration + hold, flipped + hold] × ∞ |
| Oscillating, odd play count | [iteration + hold, flipped + hold] × repeatCount/2, then the last iteration on its own |
| Oscillating, two plays | [iteration + hold, flipped] on its own |
| Oscillating, even play count | [iteration + hold, flipped + hold] × (repeatCount−1)/2, then [iteration + hold, flipped] on its own |

The last iteration never ends with a hold. The holds between iterations, `[endHold + repeatDelay + startHold]`, are in the keyframes (`stretch` with `holdsUntilNext`). Each effect starts where its first iteration does, after the outermost definition starts.

**Fills.** The first effect of an entry that holds before fills backwards, and every effect of one that holds after fills forwards.

**Iterations without duration.** An iteration of 0 seconds is a play that starts and ends at the same time. Inside a longer effect, it's two keyframes at the same offset, its start values and then its end values, so the track jumps. An effect of 0 seconds has two keyframes: the start values at 0 and the end values at 1. WAAPI shows the start values before it, if it fills backwards, and the end values from its start time on.

**Order.** Effects are created in their track's order, each entry's in order, and WAAPI shows later-created effects over earlier ones.

### 5.6 Effects: values

Values on the page come from `src/waapi/css-values.ts`, and the native effects stage reads them itself:
- `CurrentValueProvider(element).get(property)` reads the property's computed value on the element as it is now;
- `checkedTextOf(property, value)` writes a value as CSS text, adding the property's default unit to a bare number, and throws for a value the property doesn't take (`CSS.supports`);
- `alignedNumbersOf(element, property, texts)` gives values as numbers in one unit.

Each item's values are a `NativeEffectScale(element, property, stops)` (`src/waapi/native-effect-scale.ts`), its resolved stops at offsets of its easing's progress:
1. **Given values** become checked CSS text as the scale is made (`checkedTextOf`). Every item resolves (§5.5), so every given value is checked, whether a keyframe shows it or not.
2. **The current value** comes in as any other value underneath, through the track's `CurrentValueProvider`.
3. **The value at an offset** (`valueAt(offset)`): a stop's own value at a stop, and otherwise the value between the stops around it, linear in the offset, continuing the nearest two past the outer ones. Stops sit at their progress, so where the easing reaches one in time depends on the easing. A value between two stops is either one at its end, or where both are the same, and otherwise the number that far between them, in the unit both come to (`alignedNumbersOf`), which each pair of stops works out once, the first time a value between them is asked for.
    - Ends that are both numbers in one unit are taken as they are.
    - Otherwise both are computed through a probe.
    - If their units still differ, it throws with what to do instead: use values in one unit, or expressions that come to one. To have values pass through, use only native easings, and give no values between 0 and 1 where repeats are played as keyframes.
4. **`flip()`** gives the same values from its end to its start, each stop moved from its offset to 1 minus it, and **`heldAt(offset)`** a scale whose every value is this one's at `offset`. **`stopOffsets`** are its stops' offsets, in order.

So a keyframe that lands on a stop passes the stop's value through as its text, and only a keyframe between stops needs numbers, and only of the stops around it. A missing value is the same: one that lands on a stop of the entry under it, or on its end held there, passes that value through, and only one that lands between stops needs numbers.

A probe is a registered custom property (`--timesfps-probe-N-a`/`-b`) with the property's syntax. It's set inline on the target with `transition: none !important` while its computed value is read, then the inline style is restored. Animations and transitions never touch a probe, and its computed value is absolute: `calc()` collapses, lengths become px, and angles become deg. Percentages stay percentages.

Each syntax has two probes with different initial values. A value that the syntax rejects reads as the initial value on both, which tells it apart from a value that happens to equal one of them. A computed value must be a single number with an optional unit, or it throws.

### 5.7 Effects: keyframes and easings

`NativeEffectBuilder.build` gives each effect its easing and keyframes through `easingAndKeyframesOf(plays, start, duration)` (`src/waapi/keyframes.ts`), each play's times as offsets of the effect, and each keyframe's value its scale's, as CSS text (§5.6).

- **On the effect.** If the effect is a single play covering its whole duration, with a whole, forward, non-spring easing and stops within 0–1 (`playEasedOnEffectOf`), the easing goes on the effect and its scale's stops become linear keyframes at their progress. Native iterations with `alternate` keep it there.
- **In the keyframes.** Otherwise the effect easing is linear and each play's easing, over its window, is split into keyframes:
  1. A spring is fitted once per spring and duration, as a spline of cubic Bézier curve segments. The ones that overlap its window are cut to it.
  2. Each curve segment is split where its progress turns back, so each piece only rises or only falls. A play with only two stops isn't, unless it's a spring: its value runs linearly with the progress everywhere, even past the stops, as WAAPI extrapolates between two keyframes.
  3. Each piece is split where it passes a stop, so between two keyframes the value runs linearly with the progress. A keyframe there takes the stop's own value, and a piece's ends take the values there (`NativeEffectScale.valueAt`).
  4. Each piece becomes a native easing, scaled to 0–1. A piece split further, as below, takes its scale's value at the progress where it's split, between its ends':
     - **Cubic Bézier:** the window is cut out of the curve and stretched. If stretching would push a handle outside the 0–1 time range, it's split once more at the inflection of x. Reversed windows reverse the definition.
     - **Steps:** a whole forward window from 0 to 1 stays a native `steps()`. Any other window becomes a `linear()` whose levels jump at the step positions, so steps never add keyframes.
     - **Linear:** linear.
- **A jump**, a play without duration, is two keyframes at the same offset, its start value and then its end value, so the track jumps.
- **Keyframe easings** lead to the next keyframe, as WAAPI's do. A keyframe without one is linear, and the last keyframe has none.
- **Offsets** are clamped to 0–1 and kept in order, because rounding can push them out and WAAPI rejects that.

### 5.8 Play

For each target, property and effect, in order, the adapter calls `element.animate()`:
- keyframe values are their CSS text;
- times are converted to milliseconds;
- `float` and `offset` become `cssFloat` and `cssOffset`, since `offset` is the keyframe's own;
- the animation's `id` is its track entry's name and the property, `name:property`, or the property alone for an animation on its own (§3.7).

`animate` returns an `AnimationControls` over the native `Animation`s. It plays, pauses, cancels, finishes and seeks all of them together, and sets their playback rate and start time, in seconds. `finished` settles once they all have. `onFinish` and `onCancel` call a listener each time every animation has dispatched that event, and return a function that removes it.

## 6. Decisions

| Decision | Why |
|---|---|
| Definitions are value-free; every change is 0→1 | One definition serves any properties, targets and engine |
| Duration lives in the transition | A physical spring's duration comes from its physics |
| Spring quantities are in progress units | Values don't exist at definition time, and spring motion scales linearly |
| Timings resolve their transition, delay and repeats as they're made | Planning only places what's resolved, a spring that can't come to rest throws where the timing is made, and a timing shares one easing every time it's played |
| Resolved transitions are cached by value, bounded | Equal transitions in different timings share the spring math and the spring fits, and velocities from gestures can't grow the cache forever |
| Easings are windowed and keep raw progress | Splitting, cutting and reversing are all window operations, and a spring window can start and end at the same progress |
| Easing math in the core, WAAPI conversion in the adapter | Spline fitting, CSS pieces and `linear()` are engine concerns |
| Mirror flips the progress and keeps the easing | That's what makes a mirrored spring settle the way it started |
| Animations are unnamed; entries are named | The same animation can be placed many times |
| Positions and references are local to each sequence | Entry names only need to be unique within their sequence |
| The plan is resolved at adaptation | Staggers depend on the element count, which only the targets give, resolved in the scope |
| The plan places the definition in time entirely: starts after the outermost definition starts, each target's delay added, and repeats as runs | The tracks stage only lays that out by target and property |
| Entries without targets have no plan | Nothing downstream has to handle an entry that plays nothing; positions still see them |
| Errors by kind: `RangeError`, `TypeError`, `SyntaxError`, `Error` | A caller can tell a bad number, a bad shape, a bad position and a bad state apart (§3.10) |
| Track runs named by entry path | Definitions are reusable, so identity is the place in the tree, not the object |
| Values resolved per target, through probes | Relative units depend on the element; probes are untouched by animations and give absolute values |
| Values resolved after the tracks, which leave missing ones as `null` | Current values and numbers depend on the element, only interpolation needs numbers, and what shows under an entry depends on how the stage that plays the tracks plays them |
| Trimming narrows a play's easing's window, and keeps its scale | The easing keeps its progress, so every stop the trimmed easing still reaches stays where it was, and splitting is left to the stage that needs it |
| Tracks are engine-agnostic | They describe repeats as what happens, not how a definition asked for it: runs with a repeat count, a repeat delay and what an oscillation flips, and holds before and after, whatever renders them. The WAAPI side decides what it repeats natively and what it lays out in keyframes |
| Constructors validate and clamp | Every way of making a definition is checked, not only the factories |
| Tracks per target and property | WAAPI stacks effects per property, and units differ between entries |
| Overlapping entries layer, stacked by start, and only a repeating sequence's entries stay together, as a group | WAAPI already shows the earlier effect again, from where it is, once the later one ends. A repeat plays everything in it again together, which only one effect can, so the WAAPI side flattens a group into one iteration of plays |
| The tracks stage keeps repeating sequences as groups, and flattens nothing | Flattening only serves an engine that can't nest repeats; an engine that can plays the groups as they are |
| A missing value takes the value underneath it: the topmost of the entries under it with a value there, running or held, or else the current value | It's what WAAPI shows there, the topmost effect that's running or filling. Values only ever come from below, so entries resolve in stacking order, each from ones already resolved, with no cycles and nothing deferred |
| An entry after one never gives it a value | Its missing end is what's underneath it, the same rule as its start; ending where the next one starts takes giving that value |
| Continuations take their values from under them, not from their copies in the group | They're resolved like every other entry, in stacking order |
| Missing values are resolved by a pure algorithm on two interfaces | It knows nothing of tracks, resolved entries or value forms; the native effects stage implements both |
| The native effects stage reads the page itself | It's the whole engine side, so it knows how to read and write CSS values; nothing hands it a way to |
| Keyframe easings lead to the next keyframe | It's WAAPI's own model |
| Steps split into `linear()` windows, not hold-and-jump keyframes | Exact, and no extra keyframes |

## 7. Testing

`tests/tracks.test.ts` simulates how WAAPI computes effects and shows them over each other:
- iterations and directions;
- fills;
- keyframe intervals;
- cubic Bézier, steps and `linear()` easings;
- the last effect with a value showing.

It compares the result with the definitions' own math, sampled at times that miss round numbers, where steps and repeats jump. The definitions' math is: each iteration through the stops and easing, holds through repeat delays, `reverse` as time reversal, and `mirror` as `1 − progress` with the easing running forwards. Its interpolation of stops is `NumericStops` (`tests/numeric-stops.ts`), kept apart from the library's own.

The cases cover single animations through every repeat, entries in sequences, and entries in repeating sequences, through plans whose sequences tests give repeats (`withRepeats`: `repeatCount`, `repeatDelay` and `oscillate`). Easings are cubic Bézier (including overshoot), jump-start and jump-end steps, and springs. Plan, timing, fill, layering and missing-value cases are checked exactly. A builder holding after it ends when the one under its end never shows is checked on `dropCoveredEntries` and `resolveHolds` directly, since no definition lays builders in that order. The tracks themselves are checked on `TracksResolver` directly: groups kept with their own repeats, sequences that don't repeat laid out on the track around them, continuations, the holds of a group's entries, and missing values left as `null`. Missing values are checked through the effects: the value underneath from an entry that runs, one that holds its end, and none, in a track and in a repeating group, and a start whose closest entry before it doesn't hold its end. The holds WAAPI can't play are checked on hand-made tracks, since the tracks stage never gives them.

`tests/animation.test.ts` covers timings: validation and clamping, telling transition kinds apart, splitting `AnimationTimingOptions`, equal transitions sharing a descriptor, `LeastRecentlyUsedCache`, the `DampedSpring` factories, and staggers. `tests/sequence.test.ts` covers positions (parsing, one offset of each kind in order, and resolving every reference and share), sequence timings, targets, tween stops (their forms, their checks and their ends), and definitions: values checked as they're made, naming, immutability, their entries, and private constructors.

The tests run without a DOM, so they stand in for the page's globals: `tests/tracks.test.ts` stubs `CSS` and `getComputedStyle` so every value is taken, a bare number has no unit, and every property's current value is 0.25 ('none' for the values passed through). `tests/play.test.ts` plays definitions on a stand-in DOM and checks the animations' ids and staggered delays, but probes and real elements have no tests yet.

`tests/readme-examples.test-d.ts` type-checks the README's examples, and the mistakes the README says the types reject. `npm test` runs it through Vitest's type checking, with `tests/tsconfig.json`, which includes the type tests.

## 8. Limitations and open work

- **Timed tweens** exist as `TimedTweenTiming`, which is internal and can't be placed in a sequence or played yet.
- **The before flag.** Only an effect's own easing gets WAAPI's before flag. So an effect whose first keyframe starts with a jump, such as jump-start steps split by a stop or a reversed jump-end, shows the jumped value during its backwards fill.
- **Sequences have no playback options:** no delay, stagger or repeats. Merging a repeating sequence's entries (§5.4) is in place, but nothing reaches it until sequences repeat.
- **Continuations start from what's under them.** What goes on under a repeating group, from an entry in it that repeats forever, takes its missing values from what's under it on the track, not from its copy in the group, so it can carry on from different values than the copy played with.
- **Probes are global.** They're registered once per document and can't be unregistered.
