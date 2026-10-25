/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { mock, test, TestContext } from "node:test";

import type { MPDPlayerState } from "./native";

const Native = {
    seek: async (_songId: string, _positionMs: number) => { },
    getAlbumArt: async () => null,
    stopWatching: async () => { },
    waitForState: (): Promise<MPDPlayerState | null> => Promise.resolve(null)
};

mock.module("@webpack", { exports: { proxyLazyWebpack: (factory: () => unknown) => factory() } });
mock.module("@webpack/common", {
    exports: { Flux: { Store: class { emitChange() { } } }, FluxDispatcher: {} }
});
Object.defineProperty(globalThis, "VencordNative", { value: { pluginHelpers: { MPDControls: Native } } });

async function setup(t: TestContext, isPlaying = true) {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000 });
    t.mock.method(console, "error", () => { });
    let nextState = Promise.withResolvers<MPDPlayerState | null>();
    t.mock.method(Native, "waitForState", () => nextState.promise);
    const request = Promise.withResolvers<void>();
    const seek = t.mock.method(Native, "seek", () => request.promise);

    const { MPDStore: store } = await import("./MPDStore");
    t.after(() => store.stop());

    const state: MPDPlayerState = {
        track: { id: "7", uri: "test.flac", title: "Track", artists: [], album: "", durationMs: 180_000 },
        isPlaying,
        positionMs: 12_000,
        volume: 50,
        repeat: "off",
        shuffle: false
    };

    async function update(state: MPDPlayerState) {
        const pending = nextState;
        nextState = Promise.withResolvers<MPDPlayerState | null>();
        pending.resolve(state);
        await Promise.resolve();
    }

    store.start();
    await update(state);
    return { store, state, update, request, seek };
}

for (const isPlaying of [true, false]) {
    test(`keeps the requested seek position while ${isPlaying ? "playing" : "paused"} until MPD updates`, async t => {
        const { store, state, update, request, seek } = await setup(t, isPlaying);
        const positions: number[] = [];
        t.mock.method(store, "emitChange", () => positions.push(store.positionMs));

        const seeking = store.seek(60_000);
        assert.deepEqual(positions, [60_000]);
        assert.deepEqual(seek.mock.calls[0].arguments, ["7", 60_000]);
        assert.equal(store.isSettingPosition, true);

        t.mock.timers.tick(500);
        request.resolve();
        await seeking;
        assert.equal(store.positionMs, isPlaying ? 60_500 : 60_000);
        assert.equal(store.isSettingPosition, false);

        await update({ ...state, positionMs: 61_000 });
        assert.equal(store.positionMs, 61_000);
    });
}

test("restores the playback clock when a seek fails without an MPD update", async t => {
    const { store, request } = await setup(t);
    const seeking = store.seek(60_000);
    t.mock.timers.tick(2_000);
    request.reject(new Error("Seek failed"));
    await seeking;

    assert.equal(store.positionMs, 14_000);
    assert.equal(store.isSettingPosition, false);
});

for (const succeeds of [true, false]) {
    test(`preserves an MPD update received before a seek ${succeeds ? "succeeds" : "fails"}`, async t => {
        const { store, state, update, request } = await setup(t);
        const seeking = store.seek(60_000);
        await update({ ...state, isPlaying: false, positionMs: 60_000 });

        t.mock.timers.tick(1_000);
        if (succeeds)
            request.resolve();
        else
            request.reject(new Error("Seek failed"));
        await seeking;

        assert.equal(store.positionMs, 60_000);
        assert.equal(store.isPlaying, false);
        assert.equal(store.isSettingPosition, false);
    });
}
