/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import net, { Socket } from "node:net";
import { test, TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { IpcMainInvokeEvent } from "electron";

import { stopWatching, waitForState } from "../native";

const IDLE_COMMAND = "idle player mixer options playlist database output";

interface Client {
    socket: Socket;
    pending: Set<string>;
    idle: boolean;
}

async function setup(t: TestContext) {
    const sender = Object.assign(new EventEmitter(), { id: 1 });
    const event = { sender } as unknown as IpcMainInvokeEvent;
    const commands: string[] = [];
    const commandEvents = new EventEmitter();
    const clients = new Set<Client>();
    const state = { volume: 50, elapsed: 12, playing: true, random: false, title: "First track" };
    let connections = 0;
    let onCommand: ((command: string) => boolean | void) | undefined;

    function notify(client: Client) {
        if (client.idle && client.pending.size) {
            client.socket.write([...client.pending].map(system => `changed: ${system}\n`).join("") + "OK\n");
            client.pending.clear();
            client.idle = false;
        }
    }

    const server = net.createServer(socket => {
        connections++;
        const client = { socket, pending: new Set<string>(), idle: false };
        clients.add(client);
        socket.on("close", () => clients.delete(client));
        socket.write("OK MPD 0.24.0\n");

        let buffer = "";
        socket.on("data", chunk => {
            buffer += chunk.toString();
            while (buffer.includes("\n")) {
                const newline = buffer.indexOf("\n");
                const command = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                commands.push(command);
                commandEvents.emit("command");
                if (onCommand?.(command))
                    continue;

                if (command === "status") {
                    socket.write(`volume: ${state.volume}\nrepeat: 0\nsingle: 0\nrandom: ${Number(state.random)}\nstate: ${state.playing ? "play" : "pause"}\nsongid: 7\nelapsed: ${state.elapsed}\nOK\n`);
                } else if (command === "currentsong") {
                    socket.write(`file: test.flac\nId: 7\nTitle: ${state.title}\nduration: 180\nOK\n`);
                } else if (command === IDLE_COMMAND) {
                    client.idle = true;
                    notify(client);
                } else {
                    socket.write("ACK [5@0] {} unknown command\n");
                }
            }
        });
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as net.AddressInfo;
    const connect = net.createConnection;
    t.mock.method(net, "createConnection", () => connect({ host: "127.0.0.1", port: address.port }));
    t.after(async () => {
        sender.emit("destroyed");
        for (const { socket } of clients)
            socket.destroy();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    return {
        sender, event, commands, clients, state,
        get connections() { return connections; },
        onCommand(callback: typeof onCommand) { onCommand = callback; },
        change(system: string) {
            for (const client of clients) {
                client.pending.add(system);
                notify(client);
            }
        },
        async waitForCommand(command: string, count = 1) {
            while (commands.filter(value => value === command).length < count)
                await once(commandEvents, "command");
        }
    };
}

test("reads initial state, then waits for events without polling or timing out", { timeout: 8_000 }, async t => {
    const mpd = await setup(t);
    const initial = await waitForState(mpd.event, "watcher");
    assert.equal(initial?.track?.title, "First track");
    assert.equal(initial?.positionMs, 12_000);

    const update = waitForState(mpd.event, "watcher");
    await mpd.waitForCommand(IDLE_COMMAND);
    assert.equal(await Promise.race([update, delay(3_200, "still waiting")]), "still waiting");
    assert.deepEqual(mpd.commands, ["status", "currentsong", IDLE_COMMAND]);

    mpd.state.elapsed = 45;
    mpd.state.title = "Updated track";
    mpd.change("player");
    const state = await update;
    assert.equal(state?.track?.title, "Updated track");
    assert.equal(state?.positionMs, 45_000);
    assert.equal(mpd.connections, 1);

    for (const system of ["mixer", "options", "playlist", "database", "output"]) {
        // Events received between calls must remain queued on the same MPD connection.
        mpd.state.volume++;
        mpd.change(system);
        assert.equal((await waitForState(mpd.event, "watcher"))?.volume, mpd.state.volume);
    }
});

test("keeps events that arrive while reading a snapshot", { timeout: 2_000 }, async t => {
    const mpd = await setup(t);
    mpd.onCommand(command => {
        if (command === "currentsong") {
            mpd.state.volume = 80;
            mpd.change("mixer");
        }
    });

    assert.equal((await waitForState(mpd.event, "watcher"))?.volume, 50);
    assert.equal((await waitForState(mpd.event, "watcher"))?.volume, 80);
});

test("stops pending waits and protects a replacement watcher from a late stop", { timeout: 2_000 }, async t => {
    const mpd = await setup(t);
    await waitForState(mpd.event, "old");
    const oldUpdate = waitForState(mpd.event, "old");
    await mpd.waitForCommand(IDLE_COMMAND);

    await waitForState(mpd.event, "new");
    assert.equal(await oldUpdate, null);
    stopWatching(mpd.event, "old");
    const newUpdate = waitForState(mpd.event, "new");
    await mpd.waitForCommand(IDLE_COMMAND, 2);
    mpd.state.playing = false;
    mpd.change("player");
    assert.equal((await newUpdate)?.isPlaying, false);

    const stoppedUpdate = waitForState(mpd.event, "new");
    await mpd.waitForCommand(IDLE_COMMAND, 3);
    stopWatching(mpd.event, "new");
    assert.equal(await stoppedUpdate, null);
    assert.equal(mpd.sender.listenerCount("destroyed"), 0);
});

test("cancels a watcher stopped during connection setup", { timeout: 2_000 }, async t => {
    const mpd = await setup(t);
    const initial = waitForState(mpd.event, "watcher");
    stopWatching(mpd.event, "watcher");
    assert.equal(await initial, null);
    assert.deepEqual(mpd.commands, []);
});

for (const lifecycle of ["destroyed", "render-process-gone", "did-navigate"]) {
    test(`closes the idle connection on ${lifecycle}`, { timeout: 2_000 }, async t => {
        const mpd = await setup(t);
        await waitForState(mpd.event, "watcher");
        const update = waitForState(mpd.event, "watcher");
        await mpd.waitForCommand(IDLE_COMMAND);
        mpd.sender.emit(lifecycle, {}, "https://discord.com/app", false, true);
        assert.equal(await update, null);
        for (const name of ["destroyed", "render-process-gone", "did-navigate"])
            assert.equal(mpd.sender.listenerCount(name), 0);
    });
}

test("keeps watching during an unfinished navigation or an in-page navigation", { timeout: 2_000 }, async t => {
    const mpd = await setup(t);
    await waitForState(mpd.event, "watcher");
    const update = waitForState(mpd.event, "watcher");
    await mpd.waitForCommand(IDLE_COMMAND);
    mpd.sender.emit("did-start-navigation", {}, "https://discord.com/app", false, true);
    mpd.sender.emit("did-navigate-in-page", {}, "https://discord.com/app#test", true);
    mpd.state.volume = 65;
    mpd.change("mixer");
    assert.equal((await update)?.volume, 65);
});

test("opens a fresh connection after MPD disconnects", { timeout: 2_000 }, async t => {
    const mpd = await setup(t);
    await waitForState(mpd.event, "watcher");
    const update = waitForState(mpd.event, "watcher");
    await mpd.waitForCommand(IDLE_COMMAND);
    const disconnected = assert.rejects(update, /closed the connection/);
    for (const { socket } of mpd.clients)
        socket.destroy();
    await disconnected;

    mpd.state.random = true;
    assert.equal((await waitForState(mpd.event, "watcher"))?.shuffle, true);
    assert.equal(mpd.connections, 2);
});

test("restores command timeouts after leaving idle", { timeout: 6_000 }, async t => {
    const mpd = await setup(t);
    await waitForState(mpd.event, "watcher");
    const update = waitForState(mpd.event, "watcher");
    await mpd.waitForCommand(IDLE_COMMAND);
    mpd.onCommand(command => command === "status");
    mpd.change("player");
    await assert.rejects(update, /Timed out while communicating with MPD/);
    assert.equal(mpd.sender.listenerCount("destroyed"), 0);
});
