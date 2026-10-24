import {describe, it} from "vitest";
import {animation, AnimationTiming, cubicBezier, type Definition, animator, sequence, SequenceTiming, stagger, steps} from "../src/index.ts";

declare const heading: Element, first: Element, second: Element, featuredList: Element, archiveList: Element, element: Element, scope: Element;
declare const definition: Definition;
const timing = {duration: 0.4};

describe("the README's examples", () => {
    it("type-check as the entry points show them", () => {
        const page = animator();
        page.animate('.card', {opacity: [0, 1], scale: [0.95, 1]}, {duration: 0.4, easing: 'easeOut'});
        page.animate('.dot', {scale: [1, 1.4]}, {
            visualDuration: 0.3, bounce: 0.4,
            delay: stagger(0.05, {from: 'center'}),
            repeat: Infinity, repeatMode: 'mirror', repeatDelay: 0.6
        });
        const intro = sequence()
            .add('h1', {opacity: [0, 1], translate: [-40, 0]}, {duration: 0.6, bounce: 0.2}, {name: 'title'})
            .add('h2', {opacity: [0, 1]}, {duration: 0.4, easing: 'easeOut'}, {at: '-0.3'})
            .add('#cta', {scale: [0.8, 1]}, {stiffness: 300, damping: 20}, {at: 'title<+50%'})
            .build();
        page.animate(intro);
        const cards = sequence()
            .add('.card', {translate: [40, 0]}, {duration: 0.6, bounce: 0.2, delay: stagger(0.1)})
            .add('.card .icon', {opacity: [0, 1]}, {duration: 0.3, delay: stagger(0.1)})
            .build();
        animator({scope: featuredList}).animate(cards);
        animator({scope: archiveList}).animate(cards);
    });

    it("type-check as `animation` shows its targets, values and timing", () => {
        animation(heading, {opacity: 1}, timing);
        animation([first, second], {opacity: 1}, timing);
        animation(scope => scope.querySelectorAll('li'), {opacity: 1}, timing);
        animation('.card', {opacity: 1, scale: [0.9, 1.05, 1], translate: {0: -40, 0.7: 8, 1: 0}}, timing);
        animation('.card', {opacity: [0, null], width: [null, 1]}, timing);
        animation('.card', {'--y': {0: '20px', 1: '0px'}}, {duration: 0.6, bounce: 0.2});
        animation('.card', {opacity: [0, 1]}, {duration: 0.4, easing: 'easeOut', delay: 0.1, repeat: 2, repeatMode: 'reverse'});

        const transitions = [
            {duration: 0.4}, {duration: 0.4, easing: 'easeInOut'}, {duration: 0.6, easing: [0.3, 1.6, 0.6, 1]},
            {duration: 1, easing: [4, 'jumpStart']}, {duration: 0},
            {duration: 0.6, easing: cubicBezier(0.3, 1.6, 0.6, 1)}, {duration: 1, easing: steps(4, 'jumpStart')},
            {duration: 0.6, bounce: 0.3}, {visualDuration: 0.4, bounce: 0.2}, {stiffness: 260, damping: 22, mass: 1}
        ] as const;
        for (const transition of transitions) AnimationTiming.of(transition);

        stagger({step: 0.05});
        stagger({spread: 0.4, from: 'center'});
        stagger({step: 0.05, startDelay: 0.2});
        stagger({step: 0.05, from: 'last', easing: 'easeOut'});
        stagger(0.05);
        stagger(0.05, {from: 'last', easing: 'easeOut'});
    });

    it("type-check as `sequence` shows its entries, positions and nesting", () => {
        const fadeIn = animation('.note', {opacity: [0, 1]}, {duration: 0.3});
        const intro = sequence()
            .add('h1', {opacity: [0, 1]}, {duration: 0.6, bounce: 0.2}, {name: 'title'})
            .add(fadeIn, {at: 'title<+0.2'})
            .build();
        const card = sequence()
            .add('.card', {scale: [1, 1.05]}, {duration: 0.3, easing: 'easeOut'})
            .add('.card .icon', {opacity: [0.6, 1]}, {duration: 0.5}, {at: '<'})
            .build();
        sequence()
            .add(intro, {name: 'intro'})
            .add(card, {at: '-0.2'})
            .build();
        const positions = [
            '', '>', '<', '<<', '>>', 1.5, '+0.2', '<-0.1', '<+25%', '-25%', '<<+50%', '>>-25%', '-=25%', '>>+=10%', '<+50%-=50%+0.1'
        ] as const;
        for (const at of positions) sequence().add('h1', {opacity: 1}, timing, {at});
        sequence()
            .add('h1', {opacity: 1}, timing, {name: 'title'})
            .add('h2', {opacity: 1}, timing, {at: 'title'})
            .add('h2', {opacity: 1}, timing, {at: 'title>'})
            .add('h2', {opacity: 1}, timing, {at: 'title<'})
            .add('h2', {opacity: 1}, timing, {at: 'title+0.2'})
            .add('h2', {opacity: 1}, timing, {at: 'title<+50%'});
    });

    it("type-check as the reusable timings and the controls show them", () => {
        const rise = AnimationTiming.of({duration: 0.6, bounce: 0.2}, {delay: 0.1, repeat: 1});
        animation('.card', {translate: [40, 0]}, rise);
        animation('.panel', {opacity: [0, 1]}, rise);
        const reveal = SequenceTiming.builder()
            .add(rise, 'title')
            .add({duration: 0.4, easing: 'easeOut'}, 'subtitle', '-0.3')
            .add({stiffness: 300, damping: 20}, 'cta', 'title<+50%')
            .build();
        animator().animate(reveal, {
            title: ['h1', {opacity: [0, 1], translate: [-40, 0]}],
            subtitle: ['h2', {opacity: [0, 1]}],
            cta: ['#cta', {scale: [0.8, 1]}]
        });
        animator().animate(sequence(reveal, {
            title: ['h1', {opacity: [0, 1]}],
            subtitle: ['h2', {opacity: [0, 1]}],
            cta: ['#cta', {scale: [0.8, 1]}]
        }));

        animator({scope}).animate(definition);
        animator().animate('.card', {opacity: [0, 1]}, {duration: 0.6, bounce: 0.2, delay: stagger(0.1)});
        animator().animate(element, {opacity: [0, 1]}, {duration: 0.4, easing: 'easeOut', repeat: 2, repeatMode: 'reverse'});
    });

    it("reject what the README says the types reject", () => {
        // @ts-expect-error: keys from two kinds of transition
        AnimationTiming.of({duration: 1, easing: 'easeIn', bounce: 0.2});
        // @ts-expect-error: no earlier entry is named "later"
        sequence().add('h1', {opacity: 1}, timing, {at: 'later<'});
        // @ts-expect-error: two offsets of one kind
        sequence().add('h1', {opacity: 1}, timing, {at: '<+1-1'});
        // @ts-expect-error: offsets out of order
        sequence().add('h1', {opacity: 1}, timing, {at: '<-1+50%'});
        const reveal = SequenceTiming.builder().add(timing, 'title').add(timing, 'subtitle').build();
        // @ts-expect-error: the mapping names every entry
        sequence(reveal, {title: ['h1', {opacity: 1}]});
        // @ts-expect-error: the mapping names every entry, when it's played too
        animator().animate(reveal, {title: ['h1', {opacity: 1}]});
        // @ts-expect-error: a stagger takes step or spread, not both
        stagger({step: 0.1, spread: 1});
        // @ts-expect-error: spread is only given by name
        stagger(0.1, {spread: 1});
    });
});
