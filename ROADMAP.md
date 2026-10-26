# Roadmap

What's planned for TimesFPS, grouped by area. Claude proposals are not final decisions; I may or may not go with them.

## Timing and choreography

### Repeat with offset

Start a repeat where the previous iteration ended. I'm probably not going to do this right now but we have to make sure that the system stays open to extension and closed to modification.

### Stagger grid

Like GSAP's. 

### Repeats of staggered animations

A staggered animation repeats either as a whole, so each play starts once every element has finished the one before it, or each element on its own.

- **Reversed stagger order.** When the whole repeats back and forth, every other play can reverse the stagger order, so the elements that started last start first, and the ones that started first start last.
- **Preserved stagger order.** When the whole repeats back and forth, it can also keep the original order: each element plays backwards, but the first one still starts first.

The options are proposed under [Repeat options](#repeat-options).

### Nested repeats

Sequences repeat at every level of nesting, each with its own repeat options, inside the repeats around it.

### Staggered sequences

A whole sequence plays on each element of its targets, with a stagger between the elements. Each **lane** plays the sequence on one index: the first lane on the first element of every entry, the second lane on the second, and so on.

#### Lane alignment

The largest element set decides how many lanes there are, so an entry with fewer elements needs to be placed among them. A function places each element in a lane, and a utility like `stagger` creates that function from intuitive options.

**What does the function look like?**

Claude proposal: `(index, count, laneCount) => lane`, where `lane` can be fractional. The stagger formula already takes fractional indices, so an element between two lanes gets the delay between theirs.

**What are the ways to align?**

Claude proposal: two families, fixed positions and distributions, with the vocabulary of CSS's [`justify-content`](https://developer.mozilla.org/en-US/docs/Web/CSS/justify-content), which developers already know:

| Option | Lanes for 3 elements among 6 |
|---|---|
| `'start'` | 0, 1, 2 |
| `'center'` | 1.5, 2.5, 3.5 |
| `'end'` | 3, 4, 5 |
| `'space-between'` | 0, 2.5, 5: the outer elements on the outer lanes |
| `'space-around'` | 0.83, 2.5, 4.17: half a gap at each end |
| `'space-evenly'` | 1.25, 2.5, 3.75: the same gap everywhere, ends included |

```ts
import {align} from "timesfps";

align('center')
align('space-evenly')
```

**How many ways can it distribute?**

Claude proposal: three. A linear distribution can only differ in how much of a gap it leaves at the ends: none (`'space-between'`), half (`'space-around'`) or a whole one (`'space-evenly'`). Any other spacing isn't linear, and a custom function covers it.

**Should it take an easing?**

Claude proposal: no. Lanes become delays through the stagger, and the stagger already has `easing` and `from`, so an easing here would be a second way to shape the same delays.

**Where does a single element go?**

Claude proposal: in the middle lane, for every distribution. CSS falls back to the start for `space-between`, which isn't useful here.

**Should fractional lanes snap to whole ones?**

Open. A `snap` option would round each element to the nearest lane, so its delay matches one a full-size entry also has.

### Repeats of staggered sequences

A staggered sequence repeats either as a whole, so each play starts once every lane has finished the one before it, or each lane on its own. When the whole repeats back and forth, it can reverse the stagger order or keep the original one, as staggered animations do.

### Repeat options

These options apply to staggered animations and staggered sequences alike.

**Should scope and order be one option or two?**

Claude proposal: two, since they answer different questions, and every combination of order and `repeatMode` is useful:

| `repeatMode` | Natural order on every other play | Overridden |
|---|---|---|
| `'loop'` | kept | reversed: the wave changes direction |
| `'reverse'` | reversed: the whole plays backwards | kept: each element plays backwards, but the first one still starts first |
| `'mirror'` | kept | reversed |

```ts
{repeat: Infinity, repeatMode: 'reverse', repeatScope: 'whole', repeatOrder: 'preserve'}
```

| Option | Values | Default |
|---|---|---|
| `repeatScope` | `'lanes'`: each lane repeats on its own. `'whole'`: every play waits for every lane. | `'lanes'` |
| `repeatOrder` | `'preserve'` or `'reverse'`: the stagger order on every other play. | what the `repeatMode` gives naturally |

- The names follow `repeat`, `repeatDelay` and `repeatMode`.
- `repeatOrder` with `repeatScope: 'lanes'` throws, since lanes that repeat on their own have no shared order.

Claude note: a default that changes with `repeatMode` may surprise people. A fixed default, such as `'preserve'`, is easier to predict, but then `repeatMode: 'reverse'` alone no longer plays the whole backwards.

**What do other libraries do?**

- **GSAP** sets the scope by where `repeat` and `yoyo` go ([Staggers](https://gsap.com/resources/getting-started/Staggers/), [GSAP 3 change in yoyo behavior for staggers](https://gsap.com/community/forums/topic/21895-gsap-3-change-in-yoyo-behavior-for-staggers/)):
    - On the tween, as in `gsap.to('.box', {y: 100, stagger: 0.1, repeat: -1, yoyo: true})`, the whole repeats once every element has finished, and a yoyo plays the whole backwards, so the first element to start is the last to end.
    - Inside the stagger object, as in `stagger: {each: 0.1, repeat: -1, yoyo: true}`, each element repeats on its own.
    - There's no option to keep the order while the whole yoyos.
- **Motion** ([`animate`](https://motion.dev/docs/animate?via=cptv8), [stagger tutorial](https://motion.dev/tutorials/js-stagger)):
    - `repeat` on a staggered animation repeats each element on its own.
    - A sequence's top-level options take `repeat` and `repeatType`, as in `animate(sequence, {repeat: 2})`, which repeat the whole sequence. Its segments don't take `repeatType` or `repeatDelay`.
    - There's no option for the stagger order.

### Per-property timings

One animation gives each property its own transition, delay and repeats.

### Timed tween sequences

Tweens that run one after another, each with its own transition, delay and finite repeats.

## Values

### How values are taken

Decide how the library takes values wherever it has to compute one between two others: for keys that don't land on a stop, for a spring's overshoot, and for retargeting and relative values. Two approaches:

- **Parsed values with the library's own bindings.** Values come as `[value][unit]`, and transforms are animated through the library's own properties, such as `x`, `y`, `scale` and `rotate`, as Motion and GSAP do.
- **Native interpolation.** The browser interpolates: the library sets a paused WAAPI animation's `currentTime` and reads the computed value.

**How do they compare?**

| | Parsed values | Native interpolation |
|---|---|---|
| Values covered | What's parsed: numbers with units, and whatever else gets its own parser, such as colors, filters or shadows | Every interpolable CSS value: colors, `calc()`, mixed units, filters, shapes |
| Matching the browser | By hand, rule by rule, such as which color space colors interpolate in | Exact |
| Mixed units, such as `%` to `px` | Needs the layout to convert | The browser resolves them |
| Needs a DOM | No: works on the server, in workers, in tests and on other engines | Yes: an element in a document |
| Cost per read | Arithmetic | A style recalculation |
| Past the end values, for overshoot | Extrapolates directly | Only through an easing whose output passes 1, and clamped wherever CSS clamps, such as in colors |
| Velocity, for retargeting | Exact, from the formula | Two reads and the difference between them |
| Transforms | Kept as components, so each one animates and reads on its own | `transform` reads back as a `matrix()`, losing its components. `translate`, `rotate` and `scale` read back as themselves. |
| Engines and adapters | Motion's and GSAP's own vocabulary | CSS, which adapters translate |

Claude proposal: both, behind one way of interpolating. The library parses `[number][unit]` itself, which covers most values and works anywhere, and falls back to native interpolation for everything else. Property names stay CSS's:
- `translate`, `rotate` and `scale` already animate independently of each other.
- WAAPI's `composite: 'add'` adds separate animations of one property, so `translate`'s x and y can still run on their own timings.

So bindings like `x` and `y` aren't needed on WAAPI. The Motion and GSAP adapters would map the names to their own.

### Relative values

Values relative to the current one, as GSAP's `'+=100'` and `'-=50'`.

Claude note: in a sequence, an entry's relative value should build on what the earlier entries leave, so two `'+=100px'` entries move 200px in all. GSAP gets this by recording start values when each tween first renders. On WAAPI, `composite: 'add'` gives it natively for adding and subtracting: the animation adds to whatever is underneath, earlier animations included.

## Controls

### Retargeting

A running animation is redirected to new values, continuing from its current value and velocity, so interruptions stay fluid.

### Current time

A `currentTime` get accessor on the controls, in seconds from the start of the definition, as `seek` takes. It reads the time off an animation that repeats forever, or else off the one that ends last. When that animation is retargeted, it picks a new one. Retargeted animations keep the same timeline, so the time carries on unbroken.

Claude note: it gives `null` once the controls are canceled, as a native animation's `currentTime` does.

### Selecting a target's controls

The controls expose a way to select the controls of a specific target's animations.

Claude proposal: `controls.select(target)`, which takes the same targets as `animation()` (an element, elements, a selector, or a function that derives them from the scope) and gives controls with the same API over just those animations. Its time still counts from the start of the definition, so `seek` and `currentTime` mean the same on a selection as on the whole.

Claude note: a selection played, paused or sought on its own falls out of step with the rest of the definition. Whether that's allowed, and whether the whole's controls bring it back in step, needs deciding.

## Integrations

- **React components and hooks.** Animations declared on components, and hooks that create and control them.
- **Engines.** Adapters for Motion and GSAP, so the same timing and choreography run on either one, or a JavaScript engine of TimesFPS's own.

## Animation types

- **Layout animations.** Changes in an element's size and position animate smoothly between layouts.

## Triggers and timelines

### Timelines

An option to pick the timeline that drives an animation: the document's time, a scroll timeline, a view timeline or a pointer timeline. Scroll and view timelines are native ([`ScrollTimeline`](https://developer.mozilla.org/en-US/docs/Web/API/ScrollTimeline), [`ViewTimeline`](https://developer.mozilla.org/en-US/docs/Web/API/ViewTimeline)). A pointer timeline isn't, so JavaScript drives it.

Claude note: seconds mean nothing on a scroll or view timeline, so a definition's total duration maps onto the timeline's range, and every time inside it scales along. Picking the timeline on the animator or in `animate()`, rather than in definitions, keeps timings and definitions free of playback, as they are now.

### Triggers

Triggers that start animations: scroll triggers, view triggers, click, hover, and others.

### Mixed timelines in a sequence

A sequence whose entries run on different timelines, such as scroll-driven entries where crossing a threshold triggers others that run in time. This almost certainly involves JavaScript.

Claude note: a native animation runs on one timeline, so such a sequence splits into one group per timeline, and JavaScript starts the time-driven group when the scroll-driven one crosses the threshold. Scrolling back across the threshold needs a decided behavior: reverse the triggered group, leave it, or reset it.
