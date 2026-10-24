## TimesFPS

`timesfps` is a TypeScript library for designing animations that play natively in the browser.

- **Truly fluid native springs.** Springs are fitted as cubic Béziers that follow the real motion within 0.1%, not sampled into `linear()` approximations.
- **Yoyo and mirror repeats.** Every other play runs backwards (`reverse`), or swaps its values while its easing keeps running forwards (`mirror`).
- **Repeat delays** between an animation's plays.

It's built on the Web Animations API. You describe an animation once and map it onto elements and CSS values, and it runs as native animations, with no JavaScript per frame.

<br/><br/>

## Installation

```bash
npm install timesfps
# or
yarn add timesfps
# or
pnpm add timesfps
```

The library is written in TypeScript, ships as an ES module, and includes type definitions. Everything is exported from the root `timesfps` entry point, along with the types of every option.

<br/><br/>

## Two Entry Points

You build everything with two functions:

- **`animation(target, values, timing)`** defines one animation: which elements, which values, and how it moves through them.
- **`sequence()`** lays animations out in time, and nests other sequences.

Both give you a **definition**, which an **animator** plays (see Controls). `animator()` gives you one, and its `animate()` takes a definition, or takes `animation()`'s arguments to play one animation right away. You can play a definition as many times as you like.

```ts
import {animator, sequence, stagger} from "timesfps";

const page = animator();

// A fade with a CSS easing.
page.animate('.card', {opacity: [0, 1], scale: [0.95, 1]}, {duration: 0.4, easing: 'easeOut'});

// A springy pulse that ripples out from the middle dot, forever.
page.animate('.dot', {scale: [1, 1.4]}, {
    visualDuration: 0.3, bounce: 0.4,
    delay: stagger(0.05, {from: 'center'}),
    repeat: Infinity, repeatMode: 'mirror', repeatDelay: 0.6
});

// A choreographed intro.
const intro = sequence()
    .add('h1', {opacity: [0, 1], translate: [-40, 0]}, {duration: 0.6, bounce: 0.2}, {name: 'title'})
    .add('h2', {opacity: [0, 1]}, {duration: 0.4, easing: 'easeOut'}, {at: '-0.3'})
    .add('#cta', {scale: [0.8, 1]}, {stiffness: 300, damping: 20}, {at: 'title<+50%'})
    .build();

page.animate(intro);

// One definition, played in two places: the cards lift one after another, then their icons fade in.
const cards = sequence()
    .add('.card', {translate: [40, 0]}, {duration: 0.6, bounce: 0.2, delay: stagger(0.1)})
    .add('.card .icon', {opacity: [0, 1]}, {duration: 0.3, delay: stagger(0.1)})
    .build();

animator({scope: featuredList}).animate(cards);
animator({scope: archiveList}).animate(cards);
```

<br/><br/>

## `animation`

```ts
animation(target, values, timing)
```

| Argument | What it is |
|---|---|
| `target` | The elements to animate. |
| `values` | The CSS values each property moves through. |
| `timing` | How long it takes, how it moves, when it starts and how it repeats. |

It returns an `AnimationDefinition`. Nothing is looked up or read until you play it.

### Targets

| Target | Example |
|---|---|
| One element | `animation(heading, …)` |
| Several elements: an array, a `NodeList` or any other iterable | `animation([first, second], …)` |
| A CSS selector, looked up in the scope | `animation('.card', …)` |
| A function that finds elements in the scope | `animation(scope => scope.querySelectorAll('li'), …)` |

- The **scope** is the element you pass to `animator({scope})`. It defaults to `document.documentElement`.
- A function can return one element, or any iterable of them, such as an array or a `NodeList`.
- Each element is animated once, even if the target lists it twice.
- A target that matches no elements plays nothing. In a sequence, its entry keeps its position and takes no time there.

### Values

Values are keyed by property. Each property takes its values in one of three forms:

```ts
animation('.card', {
    opacity: 1,                          // one value: animates to it
    scale: [0.9, 1.05, 1],               // a list: spread evenly from start to end
    translate: {0: -40, 0.7: 8, 1: 0}    // keyed by progress, from 0 to 1
}, timing);
```

**What a key means.** Values are keyed by **progress**, which is how far the animation has gone through its change, not through its time. The timing's easing decides how progress moves over time, and between keys the value changes linearly with progress. A spring that overshoots carries the value past its end, continuing the last stretch.

**Missing ends.**

| You write | It means |
|---|---|
| `1` or `[1]` | from the value underneath, to 1 |
| `{0.5: 1}` | from the value underneath, through 1, back to the value underneath |
| `{0: 0}` or `[0, null]` | from 0, to the value underneath |
| `[null, 1]` | from the value underneath, to 1, the same as `1` |

- **The value underneath** is what the property would show at that moment without this animation: the value an earlier animation leaves it at, or, with none, the property's current value when you call `animate()`.
- `null` at the start or the end stands for the value underneath. Between them, it's skipped.
- Keys outside 0–1 throw.

**Numbers and units.**

- A number takes the property's default unit: none for properties that take numbers (`opacity`, `scale`), `px` for lengths (`width`, `translate`), `deg` for angles (`rotate`).
- Any other value is CSS text the property takes: `'2em'`, `'50%'`, `'calc(100% - 2rem)'`, `'var(--size)'`, `'red'`.
- Properties are written in camelCase (`backgroundPositionX`). Custom properties are written as they are (`'--glow'`), and should be given their units explicitly.

**Any value the property takes works,** including colours, filters and transforms, except in these cases:

- the timing is a spring;
- the values have keys between 0 and 1, and the animation repeats with a `repeatDelay` or in `mirror` mode;
- a value is missing at 0, and the animation starts while the value underneath is still changing.

In these cases, every value must be a single number, with or without a unit (`'2em'`, `'50%'`, `'0.5turn'`), or a CSS expression that comes to one (`'calc(100% - 2rem)'`, `'var(--size)'`). Also in these cases:

| Rule | Example |
|---|---|
| Values in different units must convert to one unit on each element | `{0: 10, 1: '2em'}` works; `{0: '10px', 1: '50%'}` throws |
| A missing end takes the unit of the value underneath, so that value must be a single number with a unit, and your values must convert to it | `{1: '2em'}` from a current `width` of `120px` works |
| Properties that take several values at once throw | `transform`, a two-value `translate` |

For compound values in these cases, animate a custom property registered with `@property` and use it in your CSS:

```css
@property --y {
    syntax: '<length>';
    inherits: false;
    initial-value: 0px;
}

.card {
    translate: 0 var(--y);
}
```

```ts
animation('.card', {'--y': {0: '20px', 1: '0px'}}, {duration: 0.6, bounce: 0.2});
```

### Timing

The third argument is the timing: a **transition**, which shapes one play, with the **playback options** spread into it.

```ts
{duration: 0.4, easing: 'easeOut', delay: 0.1, repeat: 2, repeatMode: 'reverse'}
```

#### Eased transitions

```ts
{duration: 0.4}                                     // linear
{duration: 0.4, easing: 'easeInOut'}                // a preset
{duration: 0.6, easing: [0.3, 1.6, 0.6, 1]}         // a cubic Bézier, as in CSS cubic-bezier()
{duration: 1, easing: [4, 'jumpStart']}             // steps, as in CSS steps()
{duration: 0}                                       // jumps straight to the end values
```

| Easing | Values |
|---|---|
| Presets | `'linear'`, `'ease'`, `'easeIn'`, `'easeOut'`, `'easeInOut'`, the same curves as CSS's |
| Cubic Bézier | `[x1, y1, x2, y2]`. `x1` and `x2` must be within 0–1. `y` can go past 0–1 to overshoot. |
| Steps | `[count, position?]`. `position` is `'jumpStart'`, `'jumpEnd'` (the default), `'jumpNone'` or `'jumpBoth'`. `count` is a whole number, at least 1, or 2 for `'jumpNone'`. |

`cubicBezier(x1, y1, x2, y2)` and `steps(count, position?)` write the same easings by name:

```ts
import {cubicBezier, steps} from "timesfps";

{duration: 0.6, easing: cubicBezier(0.3, 1.6, 0.6, 1)}
{duration: 1, easing: steps(4, 'jumpStart')}
```

#### Springs

Springs come in three kinds. You pick one by the fields you give, and each works out how long it runs.

| Kind | Fields | How long it runs |
|---|---|---|
| Duration | `duration`, `bounce`, `velocity?` | Comes to rest exactly at `duration`. |
| Visual | `visualDuration`, `bounce`, `velocity?` | `visualDuration` sets how fast it swings; it runs on until it's at rest. |
| Physical | `stiffness`, `damping`, `mass?`, `velocity?`, `restDelta?` | Until it's at rest, as in `m·x″ = −k·x − c·x′`. `mass` defaults to 1. |

```ts
{duration: 0.6, bounce: 0.3}
{visualDuration: 0.4, bounce: 0.2}
{stiffness: 260, damping: 22, mass: 1}
```

- **`bounce`** is between -1 and 1. 0 doesn't overshoot, towards 1 it bounces more, and below 0 it creeps in more slowly. It's required.
- **`velocity`** is the starting speed, in progress per second.
- **`restDelta`** is how close to the target counts as at rest, between 0 and 1. Other springs use 0.001.
- **Durations, stiffness, damping and mass** must be positive.
- **One kind per transition.** Fields from different kinds, such as `easing` with `bounce`, or `duration` with `stiffness`, throw.

#### Delay and repeats

| Option | Meaning | Default |
|---|---|---|
| `delay` | Seconds before the first play, or a stagger. It isn't repeated. | `0` |
| `repeat` | Plays after the first. `Infinity` repeats forever. | `0` |
| `repeatDelay` | Seconds between plays, never after the last. | `0` |
| `repeatMode` | How every other play runs. | `'loop'` |

| `repeatMode` | Every other play |
|---|---|
| `'loop'` | starts from the beginning again. |
| `'reverse'` | runs backwards in time, easing included. |
| `'mirror'` | swaps the start and end values, but keeps the easing running forwards. A mirrored spring settles the same way each time. |

`NaN` and infinite times throw. Negative delays and repeats become 0, and a fractional `repeat` rounds down.

#### Staggers

A stagger gives each element its own delay, from its index among the target's elements:

```ts
import {stagger} from "timesfps";

stagger({step: 0.05})                     // 0, 0.05, 0.1, …
stagger({spread: 0.4, from: 'center'})    // the farthest elements wait 0.4 s
stagger({step: 0.05, startDelay: 0.2})    // 0.2, 0.25, 0.3, …
stagger({step: 0.05, from: 'last', easing: 'easeOut'})
```

| Option | Meaning |
|---|---|
| `step` | Seconds between neighbouring elements. |
| `spread` | Seconds the farthest elements wait after the one at `from`. Give either `step` or `spread`. |
| `startDelay` | Seconds the element at `from` waits, added to every delay. `0` by default. |
| `from` | Which element goes first: `'first'` (the default), `'last'`, `'center'`, or an index. |
| `easing` | Spreads the delays along an easing instead of evenly. |

**A number first is the `step`.** `stagger(0.05)` is `stagger({step: 0.05})`, and any other options follow it:

```ts
stagger(0.05)                             // 0, 0.05, 0.1, …
stagger(0.05, {from: 'last', easing: 'easeOut'})
```

`spread` is only given by name, in the object.

A stagger is just a function `(index, total) => seconds`, so you can pass your own as `delay` too. `step`, `spread`, `startDelay` and an index `from` must be finite numbers. A delay that comes out negative becomes 0.

<br/><br/>

## `sequence`

```ts
sequence()
    .add(target, values, timing, placement?)
    .add(definition, placement?)
    .build()
```

A sequence lays **entries** out in time. An entry is an animation, written inline or as an `animation()` definition, or another sequence.

- **Inline:** `add(target, values, timing, placement?)` takes the same arguments as `animation()`, and the entry's placement: `{name?, at?}`.
- **A definition:** `add(definition, placement?)` takes an `animation()` definition or a built sequence, with `{name?, at?}`.
- **`build()`** gives you a `SequenceDefinition`.

```ts
const fadeIn = animation('.note', {opacity: [0, 1]}, {duration: 0.3});

const intro = sequence()
    .add('h1', {opacity: [0, 1]}, {duration: 0.6, bounce: 0.2}, {name: 'title'})
    .add(fadeIn, {at: 'title<+0.2'})
    .build();
```

**Builders are immutable.** Each `add` returns a new builder, so you can branch from one without the branches affecting each other. A sequence with no entries throws when you build it.

### Names

- `name` lets later positions refer to an entry. Entries without one can't be referred to.
- Names can only contain letters, digits and underscores, and must be unique within their sequence.
- A position can only refer to a name given before it. The types check this too.

### Positions

An entry's `at` says when it starts: a **reference point**, then up to three **offsets** from it, one of each kind, in the order below. Positions are relative to the end of the **previous entry** by default.

| Reference point | Starts |
|---|---|
| omitted, `''` or `'>'` | when the previous entry ends |
| `'<'` | when the previous entry starts |
| `'title'` or `'title>'` | when the entry named `title` ends |
| `'title<'` | when the entry named `title` starts |
| `'<<'` | when the sequence starts |
| `'>>'` | when everything so far has ended |

| Offset, in order | Moves it by |
|---|---|
| `+25%`, `-25%` | a share of the **reference duration** |
| `+=25%`, `-=25%` | a share of **this** entry's duration |
| `+0.2`, `-0.3` | seconds, later or earlier |

- **The reference duration** is the referenced entry's duration, or, for `<<` and `>>`, the time from the start of the sequence until everything so far has ended.
- **An entry starts** at its position, before its `delay`, and **its duration** runs from there to when it ends, its delay and repeats included.
- **A number** is seconds from the start of the sequence: `1.5` is the same as `'<<+1.5'`.
- **Offsets add up.** `'<+50%-=50%+0.1'` centres this entry halfway through the previous one, then moves it 0.1 seconds later.

| Position | Starts                                                                     |
|---|----------------------------------------------------------------------------|
| `1.5` | 1.5 seconds after the sequence starts, the same as `<<+1.5`                |
| `'+0.2'` | 0.2 seconds after the previous entry ends                                  |
| `'<-0.1'` | 0.1 seconds before the previous entry starts                               |
| `'title+0.2'` | 0.2 seconds after `title` ends                                             |
| `'<+25%'` | a quarter of the way through the previous entry                            |
| `'-25%'` | a quarter of the previous entry before it ends, the same as `'<+75%'`      |
| `'title<+50%'` | halfway through `title`                                                    |
| `'<<+50%'` | halfway between the start of the sequence and the end of everything so far |
| `'>>-25%'` | a quarter of that time before everything so far ends                       |
| `'-=25%'` | a quarter of **this** entry before the previous entry ends                 |
| `'>>+=10%'` | a tenth of **this** entry after everything so far has ended                |

**Rules.**

- Before the first entry, the previous entry and everything so far are the start of the sequence, with a duration of 0.
- An entry that repeats forever counts as ending after its first play.
- A position that lands before the start of the sequence starts at its start.

**These throw** when you add the entry to a `SequenceTiming` builder, or when you build a `sequence()`:

| Position | Why |
|---|---|
| `'+=1'` | `=` only goes with `%`. |
| `'<0.2'` | Offsets need a sign: `'<+0.2'`. |
| `'<+-1'`, `'>-+50%'` | A sign needs an amount after it. |
| `'<+1-1'`, `'<+50%-25%'` | Two offsets of one kind: add them into one. |
| `'<-1+50%'`, `'+=50%+50%'` | Offsets go in order: `%`, then `=%`, then seconds. |
| `'title>>'`, `'title<<'` | `<<` and `>>` take no name. |
| `'later<'` | `later` isn't an earlier entry. |
| `'+abc'`, `'+Infinity'` | Not a finite number. |

### Nesting

Sequences nest:

```ts
const card = sequence()
    .add('.card', {scale: [1, 1.05]}, {duration: 0.3, easing: 'easeOut'})
    .add('.card .icon', {opacity: [0.6, 1]}, {duration: 0.5}, {at: '<'})
    .build();

const page = sequence()
    .add(intro, {name: 'intro'})
    .add(card, {at: '-0.2'})
    .build();
```

- A nested sequence is one entry of the outer one. Its own positions only place its entries within it.
- Positions never refer into a nested sequence.

### Overlaps

When entries animate the same property of the same element:

- The one added later shows over the earlier one while it runs.
- An earlier entry that falls entirely within a later one never shows.
- Only the entry that starts first holds its start values before it starts.
- An entry holds its end values after it ends, unless one added before it is still running.

<br/><br/>

## Reusable Timings

`animation()` and `sequence()` also take timing on its own, as objects you can keep and reuse anywhere. A timing never knows what it animates: it only says how a change from 0 to 1 unfolds in time.

### `AnimationTiming`

```ts
import {AnimationTiming} from "timesfps";

const rise = AnimationTiming.of({duration: 0.6, bounce: 0.2}, {delay: 0.1, repeat: 1});

animation('.card', {translate: [40, 0]}, rise);
animation('.panel', {opacity: [0, 1]}, rise);
```

`AnimationTiming.of(transition, playbackOptions?)` checks everything as soon as you call it, so mistakes throw where you make them. It goes wherever a timing does: as `animation()`'s timing, or as an inline entry's timing.

### `SequenceTiming`

A sequence timing lays out named timings, without targets or values:

```ts
import {SequenceTiming} from "timesfps";

const reveal = SequenceTiming.builder()
    .add(rise, 'title')
    .add({duration: 0.4, easing: 'easeOut'}, 'subtitle', '-0.3')
    .add({stiffness: 300, damping: 20}, 'cta', 'title<+50%')
    .build();
```

- **`add(timing, name, at?)`**: the name is required, because the mapping refers to entries by it. The timing is an `AnimationTiming`, a transition with its options, or another `SequenceTiming`. Positions work as in `sequence()`.
- **`build()`** gives you the `SequenceTiming`.
- Builders are immutable here too.

To play it, give an animator's `animate()` the timing and a **mapping** of the same shape, keyed by entry name. Each animation entry takes `[target, values]`, and a nested sequence timing takes a nested mapping:

```ts
animator().animate(reveal, {
    title: ['h1', {opacity: [0, 1], translate: [-40, 0]}],
    subtitle: ['h2', {opacity: [0, 1]}],
    cta: ['#cta', {scale: [0.8, 1]}]
});
```

The mapping has to name every entry, and the types check it. `sequence(reveal, mapping)` takes the same and gives you a `SequenceDefinition`, the same as from `build()`, so you can keep it, play it, or add it to another sequence.

<br/><br/>

## Controls

```ts
const controls = animator({scope}).animate(definition);
```

- `animator()` gives you an animator. Its `scope` is where selectors and target functions look for elements, and it defaults to `document.documentElement`.
- An animator's `animate()` takes any of these:

| Call | Plays |
|---|---|
| `animate(definition)` | An `AnimationDefinition` or a `SequenceDefinition`. |
| `animate(target, values, timing)` | The animation `animation(target, values, timing)` defines. |
| `animate(sequenceTiming, mapping)` | The sequence `sequence(sequenceTiming, mapping)` defines. |

- `animate()` looks up the targets and reads the current values at that moment, and starts playing right away. To start paused, call `pause()` right after it; nothing moves in between.
- Each `animate()` starts a fresh set of animations with their own controls.

| Control | What it does |
|---|---|
| `play()`, `pause()` | Plays or pauses everything together. |
| `cancel()` | Stops everything and removes its effects. |
| `finish()` | Jumps to the end. It throws while an animation repeats forever. |
| `seek(time)` | Moves to `time`, in seconds from the start of the definition. |
| `playbackRate` | Gets or sets the speed: 1 is normal, 2 twice as fast, negative plays backwards. |
| `startTime` | Gets or sets when it starts on the document timeline, in seconds, or `null` until that's resolved. |
| `finished` | A promise that settles once every animation has finished, so never while one repeats forever. |
| `onFinish(listener)`, `onCancel(listener)` | Calls the listener each time every animation has finished, or been canceled. Returns a function that removes it. |
| `animations` | The native `Animation` objects. |

- Animations hold their end values after they end. To let go of them, cancel the controls once they've finished.
- Each native animation's `id` is its entry's path and its property, such as `intro>title:opacity`, or just the property for an animation on its own. Unnamed entries are named `a`, `b`, … in their order.

<br/><br/>

## Migrating

### From Motion

```ts
// Motion
animate('.card', {opacity: [0, 1]}, {type: 'spring', duration: 0.6, bounce: 0.2, delay: stagger(0.1)});

// timesfps
animator().animate('.card', {opacity: [0, 1]}, {duration: 0.6, bounce: 0.2, delay: stagger(0.1)});
```

| Motion | timesfps |
|---|---|
| `animate(target, keyframes, options)` | `animator().animate(target, values, timing)` |
| `ease` | `easing`, with the same preset names and cubic Bézier arrays |
| `type: 'spring'` with `stiffness`, `damping`, `mass` | `{stiffness, damping, mass}` |
| `type: 'spring'` with `duration`, `bounce` | `{duration, bounce}`, with `bounce` required |
| `visualDuration`, `bounce` | `{visualDuration: 1.2 × Motion's, bounce}`; see below |
| `repeat`, `repeatDelay` | `repeat`, `repeatDelay` |
| `repeatType` | `repeatMode`, with the same `'loop'`, `'reverse'` and `'mirror'` |
| `stagger(0.1, {startDelay, from, ease})` | `stagger(0.1, {startDelay, from, easing})` |
| `[null, 100]` | `[null, 100]` |
| `x`, `y`, `scale`, `rotate` | CSS's individual properties: `translate`, `scale`, `rotate` |
| `animate([[target, keyframes, {at}], …])` | `sequence().add(target, values, timing, {at}) … .build()`, then `animate()` it |
| `at: '<'`, `'+0.5'`, `'-0.2'` | the same |
| Labels | entry names: `{name: 'title'}`, then `'title<'` or `'title>'` |
| `useAnimate`'s scope | `animator({scope})` |
| `time`, `speed` | `seek(time)`, `playbackRate` |
| `complete()`, `then()` | `finish()`, `finished` |

Things that work differently:

- **One easing across all values.** Motion eases each segment between keyframes on its own. Here, the easing runs once from 0 to 1, and the values change linearly with progress between their keys. Motion's `times` are fractions of the time; keys here are progress.
- **Timing is always given.** Motion picks a default transition per property. Here, every animation states its own.
- **Springs.**
    - The same `visualDuration` swings 1.2 times faster here, so pass 1.2 × Motion's.
    - `bounce` keeps having an effect up to ±1. Motion stops at ±0.95.
    - A negative `bounce` makes the spring arrive later. Motion keeps the arrival time and only changes the shape.
    - `bounce` is required, where Motion defaults it to 0.3.
    - Every spring takes `velocity`. Motion ignores it on springs given by a duration.
    - A spring settles into its end value without jumping. Motion jumps to it once it's close enough.

### From GSAP

```ts
// GSAP
gsap.from('.card', {opacity: 0, y: 20, duration: 0.4, ease: 'power2.out', stagger: 0.1});

// timesfps
animator().animate('.card', {opacity: [0, null], '--y': ['20px', null]}, {
    duration: 0.4, easing: 'easeOut', delay: stagger(0.1)
});
```

| GSAP | timesfps |
|---|---|
| `gsap.to(target, {opacity: 1})` | `animator().animate(target, {opacity: 1}, timing)` |
| `gsap.from(target, {opacity: 0})` | `{opacity: [0, null]}` or `{opacity: {0: 0}}` |
| `gsap.fromTo(target, {opacity: 0}, {opacity: 1})` | `{opacity: [0, 1]}` |
| `gsap.set(target, vars)` | `{duration: 0}` |
| `ease: 'power2.out'` | `easing`: a preset, or a cubic Bézier close to the curve |
| `repeat: -1` | `repeat: Infinity` |
| `yoyo: true` | `repeatMode: 'reverse'` |
| `repeatDelay` | `repeatDelay` |
| `stagger: 0.1` | `delay: stagger(0.1)` |
| `stagger: {each, amount, from, ease}` | `stagger({step: each, spread: amount, from, easing})`. `from: 'start'` is `'first'`, and `'end'` is `'last'`. There's no `'edges'`, `'random'` or `grid`. |
| `x: 100` | `translate: 100` |
| `y: 20` | a registered custom property, as `'--y'` above (see Values) |
| `gsap.timeline().to(target, vars, position)` | `sequence().add(target, values, timing, {at})` |
| Timeline `defaults` | a timing kept in a variable, or an `AnimationTiming` |
| `timeScale()`, `seek()`, `then()` | `playbackRate`, `seek()`, `finished` |

**Positions.** GSAP's default and its `+=`/`-=` are relative to the end of everything so far; here they're relative to the previous entry, and `>>` is "everything so far".

| GSAP | timesfps |
|---|---|
| omitted | `'>>'` |
| `'+=1'`, `'-=0.5'` | `'>>+1'`, `'>>-0.5'` |
| `'<'`, `'>'`, `'>-0.5'` | the same |
| `'<0.5'`, `'<+=0.5'` | `'<+0.5'` |
| `'label'`, `'label+=1'` | name the entry, then `'title<'` or `'title<+1'` |
| `'<25%'` | `'<+25%'` |
| `'-=25%'` | `'>>-=25%'` |
| `'<+=25%'` | the same |

### From the Web Animations API

```ts
// WAAPI
element.animate({opacity: [0, 1]}, {duration: 400, easing: 'ease-out', iterations: 3, direction: 'alternate', fill: 'forwards'});

// timesfps
animator().animate(element, {opacity: [0, 1]}, {duration: 0.4, easing: 'easeOut', repeat: 2, repeatMode: 'reverse'});
```

| WAAPI | timesfps |
|---|---|
| Milliseconds | Seconds |
| `easing: 'ease-out'` | `easing: 'easeOut'` |
| `'cubic-bezier(…)'`, `'steps(4, jump-start)'` | `[x1, y1, x2, y2]`, `[4, 'jumpStart']` |
| `iterations: 3` | `repeat: 2`, the plays after the first |
| `iterations: Infinity` | `repeat: Infinity` |
| `direction: 'alternate'` | `repeatMode: 'reverse'` |
| Keyframe `offset` | progress keys, which mean the same: positions along the eased progress |
| A single keyframe | a single value |
| `fill` | none: the overlap rules decide what holds, and end values hold |
| `animation.currentTime = ms` | `controls.seek(seconds)` |
| `play()`, `pause()`, `cancel()`, `finish()`, `finished`, `playbackRate`, `startTime` | the same, in seconds |

There's no counterpart for `direction: 'reverse'` or `'alternate-reverse'` (swap your values instead), `iterationStart`, `endDelay`, fractional iterations, or an easing per keyframe.
