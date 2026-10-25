/*
 * Vencord, a Discord client mod
 * Copyright (c) 2022 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";
import { proxyLazyWebpack } from "@webpack";
import { Flux, FluxDispatcher } from "@webpack/common";

import type { MPDPlayerState, MPDTrackState, RepeatMode } from "./native";

const Native = VencordNative.pluginHelpers.MPDControls as PluginNative<typeof import("./native")>;
const RECONNECT_DELAY = 1_000;

export interface Track extends MPDTrackState {
    artworkUrl: string | null;
}

export const MPDStore = proxyLazyWebpack(() => {
    const { Store } = Flux;

    class MPDStore extends Store {
        public basePositionMs = 0;

        public track: Track | null = null;
        public connected = false;
        public isPlaying = false;
        public repeat: RepeatMode = "off";
        public shuffle = false;
        public volume: number | null = null;
        public isSettingPosition = false;

        private running = false;
        private watcherId: string | null = null;
        private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
        private artworkGeneration = 0;
        private artworkUri: string | null = null;
        private artworkUrl: string | null = null;
        private loggedConnectionError = false;
        private positionUpdatedAt = 0;

        public get positionMs() {
            let position = this.basePositionMs;
            if (this.isPlaying)
                position += Date.now() - this.positionUpdatedAt;

            return position;
        }

        public set positionMs(position: number) {
            this.basePositionMs = position;
            this.positionUpdatedAt = Date.now();
        }

        start() {
            if (this.running)
                return;

            this.running = true;
            this.watcherId = crypto.randomUUID();
            void this.watch(this.watcherId);
        }

        stop() {
            this.running = false;
            if (this.reconnectTimeout != null)
                clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
            if (this.watcherId != null) {
                void Native.stopWatching(this.watcherId).catch(error => {
                    console.error("[VencordMPDControls] Failed to stop watching MPD", error);
                });
                this.watcherId = null;
            }
            this.clearPlayer();
            this.emitChange();
        }

        previous() {
            this.runCommand("go to the previous track", Native.previous());
        }

        next() {
            this.runCommand("go to the next track", Native.next());
        }

        setVolume(volume: number) {
            this.runCommand("set volume", Native.setVolume(volume));
        }

        setPlaying(playing: boolean) {
            this.runCommand(playing ? "resume playback" : "pause playback", Native.setPlaying(playing));
        }

        setRepeat(repeat: RepeatMode) {
            this.runCommand("set repeat mode", Native.setRepeat(repeat));
        }

        setShuffle(shuffle: boolean) {
            this.runCommand("set random mode", Native.setShuffle(shuffle));
        }

        async seek(positionMs: number) {
            if (this.isSettingPosition || !this.track)
                return;

            this.isSettingPosition = true;
            this.emitChange();

            try {
                await Native.seek(this.track.id, positionMs);
            } catch (error) {
                console.error("[VencordMPDControls] Failed to seek", error);
            } finally {
                this.isSettingPosition = false;
                this.emitChange();
            }
        }

        private async watch(watcherId: string) {
            try {
                while (this.running && this.watcherId === watcherId) {
                    const state = await Native.waitForState(watcherId);
                    if (!this.running || this.watcherId !== watcherId || state == null)
                        return;

                    this.applyState(state);
                }
            } catch (error) {
                if (!this.running || this.watcherId !== watcherId)
                    return;

                if (!this.loggedConnectionError) {
                    console.warn("[VencordMPDControls] Failed to connect to MPD", error);
                    this.loggedConnectionError = true;
                }

                this.clearPlayer();
                this.emitChange();
                this.reconnectTimeout = setTimeout(() => {
                    this.reconnectTimeout = null;
                    void this.watch(watcherId);
                }, RECONNECT_DELAY);
            }
        }

        private applyState(state: MPDPlayerState) {
            this.connected = true;
            this.loggedConnectionError = false;
            this.isPlaying = state.isPlaying;
            this.positionMs = state.positionMs;
            this.volume = state.volume;
            this.repeat = state.repeat;
            this.shuffle = state.shuffle;

            if (state.track)
                this.applyTrack(state.track);
            else
                this.clearTrack();

            this.emitChange();
        }

        private applyTrack(nextTrack: MPDTrackState) {
            let shouldLoadArtwork = false;

            if (this.artworkUri !== nextTrack.uri) {
                this.artworkUri = nextTrack.uri;
                this.artworkUrl = null;
                this.artworkGeneration++;
                shouldLoadArtwork = true;
            }

            if (
                this.track?.id !== nextTrack.id ||
                this.track.uri !== nextTrack.uri ||
                this.track.title !== nextTrack.title ||
                this.track.durationMs !== nextTrack.durationMs ||
                this.track.album !== nextTrack.album ||
                this.track.artworkUrl !== this.artworkUrl ||
                this.track.artists.length !== nextTrack.artists.length ||
                this.track.artists.some((artist, index) => artist !== nextTrack.artists[index])
            ) {
                this.track = {
                    ...nextTrack,
                    artworkUrl: this.artworkUrl
                };
            }

            if (shouldLoadArtwork)
                void this.loadArtwork(nextTrack.uri, this.artworkGeneration);
        }

        private async loadArtwork(uri: string, generation: number) {
            try {
                const artworkUrl = await Native.getAlbumArt(uri);
                if (!this.running || generation !== this.artworkGeneration || uri !== this.artworkUri)
                    return;

                this.artworkUrl = artworkUrl;
                if (this.track?.uri === uri) {
                    this.track = {
                        ...this.track,
                        artworkUrl
                    };
                    this.emitChange();
                }
            } catch {
                if (generation === this.artworkGeneration && uri === this.artworkUri)
                    this.artworkUri = null;
            }
        }

        private runCommand(description: string, command: Promise<void>) {
            void command.catch(error => {
                console.error(`[VencordMPDControls] Failed to ${description}`, error);
            });
        }

        private clearTrack() {
            this.track = null;
            this.artworkUri = null;
            this.artworkUrl = null;
            this.artworkGeneration++;
        }

        private clearPlayer() {
            this.connected = false;
            this.isPlaying = false;
            this.repeat = "off";
            this.shuffle = false;
            this.volume = null;
            this.isSettingPosition = false;
            this.positionMs = 0;
            this.clearTrack();
        }
    }

    return new MPDStore(FluxDispatcher, {});
});
