import {expect, it} from "vitest";
import {animator, sequence, SequenceTiming, stagger} from "../src/index.ts";

class FakeElement {
    created: {keyframes: object[]; options: object; id: string}[] = [];
    style = {getPropertyValue: () => '', getPropertyPriority: () => '', setProperty() {}, removeProperty() {}};
    constructor(readonly name: string) {}
    animate(keyframes: object[], options: object) {
        const animation = {id: '', keyframes, options, addEventListener() {}, removeEventListener() {}, pause() {}};
        this.created.push(animation);
        return animation;
    }
}
const card = new FakeElement('card'), icon = new FakeElement('icon'), other = new FakeElement('other'), otherIcon = new FakeElement('otherIcon');
const scope = {querySelectorAll: (selector: string) => selector === '.card' ? [card, other] : selector === '.icon' ? [icon, otherIcon] : []};
Object.assign(globalThis, {
    document: {documentElement: scope},
    CSS: {supports: (property: string, value: string) => property === 'opacity' ? value === '1' || !/[a-z%]/.test(value) : /px|%|^\d/.test(value), registerProperty() {}},
    getComputedStyle: () => ({getPropertyValue: () => '0'})
});

it("plays definitions, naming animations by entry path and property", () => {
    const definition = sequence()
        .add('.card', {translate: [40, 0], opacity: [0, 1]}, {duration: 0.6, bounce: 0.2}, {name: 'lift'})
        .add('.icon', {opacity: 1}, {duration: 0.3, delay: stagger({step: 0.1})}, {at: 'lift<+25%'})
        .build();
    const controls = animator().animate(definition);
    expect(controls.animations.map(({id}) => id).sort()).toEqual(['a:opacity', 'a:opacity', 'lift:opacity', 'lift:opacity', 'lift:translate', 'lift:translate']);
    const iconDelays = [icon, otherIcon].map(element => (element.created[0]!.options as {delay: number}).delay);
    expect(iconDelays[0]).toBeCloseTo(150);
    expect(iconDelays[1]).toBeCloseTo(250);

    const lone = animator().animate('.card', {opacity: [0, 1], translate: [0, 10]}, {duration: 1});
    expect(lone.animations.map(({id}) => id).sort()).toEqual(['opacity', 'opacity', 'translate', 'translate']);
});

it("plays a sequence timing given with its mapping, and checks the mapping as it plays", () => {
    const timing = SequenceTiming.builder().add({duration: 1}, 'fade').build();
    expect(animator().animate(timing, {fade: ['.card', {opacity: [0, 1]}]}).animations.map(({id}) => id)).toEqual(['fade:opacity', 'fade:opacity']);
    expect(() => animator().animate(timing, {} as never)).toThrow('No mapping present for "fade".');
});

it("looks for targets in its scope", () => {
    const scoped = {querySelectorAll: (selector: string) => selector === '.card' ? [card] : []};
    const controls = animator({scope: scoped as unknown as Element}).animate('.card', {opacity: [0, 1]}, {duration: 1});
    expect(controls.animations).toHaveLength(1);
});
