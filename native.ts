/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createConnection, Socket } from "node:net";

import type { IpcMainInvokeEvent } from "electron";

const MPD_HOST = "127.0.0.1";
const MPD_PORT = 6600;
const CONNECTION_TIMEOUT = 3_000;
const ARTWORK_BINARY_LIMIT = 1024 * 1024;

export type RepeatMode = "off" | "queue" | "track";

export interface MPDTrackState {
    id: string;
    uri: string;
    title: string;
    durationMs: number;
    album: string;
    artists: string[];
}

export interface MPDPlayerState {
    track: MPDTrackState | null;
    isPlaying: boolean;
    positionMs: number;
    volume: number | null;
    repeat: RepeatMode;
    shuffle: boolean;
}

class MPDAckError extends Error { }

class MPDResponse {
    public readonly fields = new Map<string, string[]>();
    public binary: Buffer | null = null;

    addField(name: string, value: string) {
        const key = name.toLowerCase();
        const values = this.fields.get(key);

        if (values)
            values.push(value);
        else
            this.fields.set(key, [value]);
    }

    get(name: string) {
        return this.fields.get(name.toLowerCase())?.at(-1);
    }

    getAll(name: string) {
        return this.fields.get(name.toLowerCase()) ?? [];
    }
}

class MPDConnection {
    private buffer = Buffer.alloc(0);
    private closed = false;
    private error: Error | null = null;
    private wakeReader: (() => void) | null = null;

    private constructor(private readonly socket: Socket) {
        socket.setNoDelay(true);
        socket.setTimeout(CONNECTION_TIMEOUT, () => {
            socket.destroy(new Error("Timed out while communicating with MPD"));
        });

        socket.on("data", chunk => {
            this.buffer = Buffer.concat([this.buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
            this.wakeReader?.();
            this.wakeReader = null;
        });
        socket.on("error", error => {
            this.error = error;
            this.wakeReader?.();
            this.wakeReader = null;
        });
        socket.on("close", () => {
            this.closed = true;
            this.wakeReader?.();
            this.wakeReader = null;
        });
    }

    static async connect() {
        const socket = createConnection({ host: MPD_HOST, port: MPD_PORT });
        const connection = new MPDConnection(socket);

        await new Promise<void>((resolve, reject) => {
            const onConnect = () => {
                socket.off("error", onError);
                resolve();
            };
            const onError = (error: Error) => {
                socket.off("connect", onConnect);
                reject(error);
            };

            socket.once("connect", onConnect);
            socket.once("error", onError);
        });

        const greeting = await connection.readLine();
        if (!greeting.startsWith("OK MPD ")) {
            connection.close();
            throw new Error("The server did not send a valid MPD greeting");
        }

        return connection;
    }

    close() {
        this.closed = true;
        this.socket.destroy();
        this.wakeReader?.();
        this.wakeReader = null;
    }

    async command(command: string) {
        await new Promise<void>((resolve, reject) => {
            this.socket.write(command + "\n", error => error ? reject(error) : resolve());
        });

        const response = new MPDResponse();

        while (true) {
            const line = await this.readLine();

            if (line === "OK")
                return response;

            if (line.startsWith("ACK "))
                throw new MPDAckError(line);

            if (line === "list_OK")
                continue;

            const separator = line.indexOf(":");
            if (separator === -1)
                continue;

            const name = line.slice(0, separator);
            const valueStart = line[separator + 1] === " " ? separator + 2 : separator + 1;
            const value = line.slice(valueStart);
            response.addField(name, value);

            if (name.toLowerCase() === "binary") {
                const size = Number.parseInt(value, 10);
                if (!Number.isSafeInteger(size) || size < 0)
                    throw new Error("MPD returned an invalid binary chunk size");

                response.binary = await this.readBytes(size);
                await this.readLine();
            }
        }
    }

    private async waitForData() {
        if (this.error)
            throw this.error;
        if (this.closed)
            throw new Error("MPD closed the connection unexpectedly");

        await new Promise<void>(resolve => {
            this.wakeReader = resolve;
        });

        if (this.error)
            throw this.error;
        if (this.closed && !this.buffer.length)
            throw new Error("MPD closed the connection unexpectedly");
    }

    private async readLine() {
        while (true) {
            const newline = this.buffer.indexOf(0x0a);
            if (newline !== -1) {
                const line = this.buffer.subarray(0, newline);
                this.buffer = this.buffer.subarray(newline + 1);
                return line.toString("utf8").replace(/\r$/, "");
            }

            await this.waitForData();
        }
    }

    private async readBytes(size: number) {
        while (this.buffer.length < size)
            await this.waitForData();

        const bytes = this.buffer.subarray(0, size);
        this.buffer = this.buffer.subarray(size);
        return bytes;
    }
}

function quoteArgument(value: string) {
    return `"${value
        .replaceAll("\\", "\\\\")
        .replaceAll("\"", "\\\"")
        .replace(/[\r\n]/g, " ")}"`;
}

function numberValue(value: string | undefined, fallback = 0) {
    if (value == null)
        return fallback;

    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function trackName(uri: string) {
    const basename = uri.slice(uri.lastIndexOf("/") + 1);

    try {
        return decodeURIComponent(basename);
    } catch {
        return basename;
    }
}

async function withConnection<T>(callback: (connection: MPDConnection) => Promise<T>) {
    const connection = await MPDConnection.connect();

    try {
        return await callback(connection);
    } finally {
        connection.close();
    }
}

async function execute(command: string) {
    await withConnection(connection => connection.command(command));
}

async function executeList(commands: string[]) {
    await execute(["command_list_begin", ...commands, "command_list_end"].join("\n"));
}

function imageMimeType(data: Buffer) {
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return "image/png";
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
        return "image/jpeg";
    if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")
        return "image/gif";
    if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP")
        return "image/webp";

    return "application/octet-stream";
}

async function readArtwork(command: "albumart" | "readpicture", uri: string) {
    return await withConnection(async connection => {
        try {
            await connection.command(`binarylimit ${ARTWORK_BINARY_LIMIT}`);
        } catch (error) {
            if (!(error instanceof MPDAckError))
                throw error;
        }

        const chunks: Buffer[] = [];
        let offset = 0;
        let totalSize: number | null = null;
        let mimeType: string | undefined;

        while (totalSize == null || offset < totalSize) {
            const response = await connection.command(`${command} ${quoteArgument(uri)} ${offset}`);
            const size = Number.parseInt(response.get("size") ?? "", 10);

            if (!Number.isSafeInteger(size) || size <= 0 || !response.binary?.length)
                return null;

            totalSize ??= size;
            mimeType ??= response.get("type");
            chunks.push(response.binary);
            offset += response.binary.length;
        }

        const data = Buffer.concat(chunks, offset);
        return `data:${mimeType || imageMimeType(data)};base64,${data.toString("base64")}`;
    });
}

export async function getState(_: IpcMainInvokeEvent): Promise<MPDPlayerState> {
    return await withConnection(async connection => {
        const status = await connection.command("status");
        const song = await connection.command("currentsong");
        const uri = song.get("file");
        const repeatEnabled = status.get("repeat") === "1";
        const singleEnabled = status.get("single") === "1";
        const rawVolume = status.get("volume");
        const parsedVolume = rawVolume == null ? null : numberValue(rawVolume, -1);
        const durationMs = numberValue(song.get("duration"), numberValue(status.get("duration"))) * 1_000;
        const artists = song.getAll("artist");

        return {
            track: uri
                ? {
                    id: song.get("id") || status.get("songid") || uri,
                    uri,
                    title: song.get("title") || song.get("name") || trackName(uri),
                    durationMs,
                    album: song.get("album") || "",
                    artists: artists.length ? artists : song.getAll("albumartist")
                }
                : null,
            isPlaying: status.get("state") === "play",
            positionMs: numberValue(status.get("elapsed")) * 1_000,
            volume: parsedVolume != null && parsedVolume >= 0 ? parsedVolume : null,
            repeat: repeatEnabled ? (singleEnabled ? "track" : "queue") : "off",
            shuffle: status.get("random") === "1"
        };
    });
}

export async function previous(_: IpcMainInvokeEvent) {
    await execute("previous");
}

export async function next(_: IpcMainInvokeEvent) {
    await execute("next");
}

export async function setPlaying(_: IpcMainInvokeEvent, playing: boolean) {
    await execute(playing ? "play" : "pause 1");
}

export async function setVolume(_: IpcMainInvokeEvent, volume: number) {
    await execute(`setvol ${Math.round(Math.min(100, Math.max(0, volume)))}`);
}

export async function setRepeat(_: IpcMainInvokeEvent, repeat: RepeatMode) {
    const commands = repeat === "track"
        ? ["single 1", "repeat 1"]
        : repeat === "queue"
            ? ["single 0", "repeat 1"]
            : ["single 0", "repeat 0"];

    await executeList(commands);
}

export async function setShuffle(_: IpcMainInvokeEvent, shuffle: boolean) {
    await execute(`random ${shuffle ? 1 : 0}`);
}

export async function seek(_: IpcMainInvokeEvent, songId: string, position: number) {
    if (!/^\d+$/.test(songId))
        throw new Error("Cannot seek without an MPD queue song ID");

    await execute(`seekid ${songId} ${Math.max(0, position / 1_000)}`);
}

export async function getAlbumArt(_: IpcMainInvokeEvent, uri: string) {
    try {
        const albumArt = await readArtwork("albumart", uri);
        if (albumArt)
            return albumArt;
    } catch (error) {
        if (!(error instanceof MPDAckError))
            throw error;
    }

    try {
        return await readArtwork("readpicture", uri);
    } catch (error) {
        if (error instanceof MPDAckError)
            return null;
        throw error;
    }
}
