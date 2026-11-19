"use client";

import {useMemo, useState, useSyncExternalStore} from "react";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {BallRace} from "./ball-race";
import {FitCharts} from "./fit-charts";
import {FitStats} from "./fit-stats";
import {SpringControls} from "./spring-controls";
import {fitSpring} from "./spring-fit";
import {initialValuesByKind, type SpringKind, transitionOf} from "./spring-parameters";

export function SpringDemo() {
    const [kind, setKind] = useState<SpringKind>("physical");
    const [valuesByKind, setValuesByKind] = useState(initialValuesByKind);
    const values = valuesByKind[kind];
    const transition = useMemo(() => transitionOf(kind, values), [kind, values]);
    // The fit plays the spring through the library's CSS values, which only the browser has.
    const inBrowser = useSyncExternalStore(subscribeToNothing, () => true, () => false);
    const fit = useMemo(() => {
        if (!inBrowser) return undefined;
        try {
            return fitSpring(transition);
        } catch (error) {
            return error instanceof Error ? error : new Error(String(error));
        }
    }, [inBrowser, transition]);

    return (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="grid min-w-0 gap-6">
                <Card className="overflow-visible">
                    <CardContent>
                        <BallRace transition={transition}/>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>Fit</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {fit instanceof Error
                            ? <p className="text-sm text-destructive">{fit.message}</p>
                            : fit && <FitCharts fit={fit}/>}
                    </CardContent>
                </Card>
            </div>
            <div className="grid gap-6 lg:sticky lg:top-6">
                <Card>
                    <CardHeader>
                        <CardTitle>Spring</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <SpringControls
                            kind={kind}
                            values={values}
                            onKindChange={setKind}
                            onValueChange={(name, value) => setValuesByKind(current => ({...current, [kind]: {...current[kind], [name]: value}}))}
                        />
                    </CardContent>
                </Card>
                {fit && !(fit instanceof Error) && (
                    <Card>
                        <CardHeader>
                            <CardTitle>Stats</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <FitStats fit={fit}/>
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    );
}

/** Nothing changes whether it runs in the browser, so there's nothing to subscribe to. */
function subscribeToNothing(): () => void {
    return () => {};
}
