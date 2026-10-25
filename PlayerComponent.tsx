/*
 * Vencord, a Discord client mod
 * Copyright (c) 2022 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./mpdStyles.css";

import { Flex } from "@components/Flex";
import { CopyIcon, ImageIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { debounce } from "@shared/debounce";
import { classNameFactory } from "@utils/css";
import { copyWithToast, openImageModal } from "@utils/discord";
import { classes } from "@utils/misc";
import { formatDuration } from "@utils/text";
import { ContextMenuApi, Menu, React, useEffect, useState, useStateFromStores } from "@webpack/common";

import { settings } from ".";
import { MPDStore, Track } from "./MPDStore";
import { SeekBar } from "./SeekBar";

const cl = classNameFactory("vc-mpd-");

function Svg(path: string, label: string) {
    return () => (
        <svg
            className={cl("button-icon", label)}
            height="24"
            width="24"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-label={label}
            focusable={false}
        >
            <path d={path} />
        </svg>
    );
}

// KraXen's icons :yesyes:
// from https://fonts.google.com/icons?icon.style=Rounded&icon.set=Material+Icons
// older material icon style, but still really good
const PlayButton = Svg("M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18c.62-.39.62-1.29 0-1.69L9.54 5.98C8.87 5.55 8 6.03 8 6.82z", "play");
const PauseButton = Svg("M8 19c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2v10c0 1.1.9 2 2 2zm6-12v10c0 1.1.9 2 2 2s2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2z", "pause");
const SkipPrev = Svg("M7 6c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1s-1-.45-1-1V7c0-.55.45-1 1-1zm3.66 6.82l5.77 4.07c.66.47 1.58-.01 1.58-.82V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07c-.57.4-.57 1.24 0 1.64z", "previous");
const SkipNext = Svg("M7.58 16.89l5.77-4.07c.56-.4.56-1.24 0-1.63L7.58 7.11C6.91 6.65 6 7.12 6 7.93v8.14c0 .81.91 1.28 1.58.82zM16 7v10c0 .55.45 1 1 1s1-.45 1-1V7c0-.55-.45-1-1-1s-1 .45-1 1z", "next");
const Repeat = Svg("M7 7h10v1.79c0 .45.54.67.85.35l2.79-2.79c.2-.2.2-.51 0-.71l-2.79-2.79c-.31-.31-.85-.09-.85.36V5H6c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1s1-.45 1-1V7zm10 10H7v-1.79c0-.45-.54-.67-.85-.35l-2.79 2.79c-.2.2-.2.51 0 .71l2.79 2.79c.31.31.85.09.85-.36V19h11c.55 0 1-.45 1-1v-4c0-.55-.45-1-1-1s-1 .45-1 1v3z", "repeat");
const Shuffle = Svg("M10.59 9.17L6.12 4.7c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41l4.46 4.46 1.42-1.4zm4.76-4.32l1.19 1.19L4.7 17.88c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0L17.96 7.46l1.19 1.19c.31.31.85.09.85-.36V4.5c0-.28-.22-.5-.5-.5h-3.79c-.45 0-.67.54-.36.85zm-.52 8.56l-1.41 1.41 3.13 3.13-1.2 1.2c-.31.31-.09.85.36.85h3.79c.28 0 .5-.22.5-.5v-3.79c0-.45-.54-.67-.85-.35l-1.19 1.19-3.13-3.14z", "shuffle");

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button
            className={cl("button")}
            {...props}
        >
            {props.children}
        </button>
    );
}

function CopyContextMenu({ name, type }: { type: string; name: string; }) {
    return (
        <Menu.Menu
            navId="vc-mpd-menu"
            onClose={ContextMenuApi.closeContextMenu}
            aria-label={`MPD ${type} Menu`}
        >
            <Menu.MenuItem
                id="vc-mpd-copy-name"
                label={`Copy ${type} Name`}
                action={() => copyWithToast(name)}
                icon={CopyIcon}
            />
        </Menu.Menu>
    );
}

function Controls() {
    const [isPlaying, shuffle, repeat] = useStateFromStores(
        [MPDStore],
        () => [MPDStore.isPlaying, MPDStore.shuffle, MPDStore.repeat]
    );

    const [nextRepeat, repeatClassName] = (() => {
        switch (repeat) {
            case "off": return ["queue", "repeat-off"] as const;
            case "queue": return ["track", "repeat-queue"] as const;
            case "track": return ["off", "repeat-track"] as const;
            default: throw new Error(`Invalid repeat state ${repeat}`);
        }
    })();

    // the 1 is using position absolute so it does not make the button jump around
    return (
        <Flex className={cl("button-row")} gap="0">
            <Button
                className={classes(cl("button"), cl("shuffle"), cl(shuffle ? "shuffle-on" : "shuffle-off"))}
                onClick={() => MPDStore.setShuffle(!shuffle)}
            >
                <Shuffle />
            </Button>
            <Button onClick={() => {
                settings.store.previousButtonRestartsTrack && MPDStore.positionMs > 3000 ? MPDStore.seek(0) : MPDStore.previous();
            }}>
                <SkipPrev />
            </Button>
            <Button onClick={() => MPDStore.setPlaying(!isPlaying)}>
                {isPlaying ? <PauseButton /> : <PlayButton />}
            </Button>
            <Button onClick={() => MPDStore.next()}>
                <SkipNext />
            </Button>
            <Button
                className={classes(cl("button"), cl("repeat"), cl(repeatClassName))}
                onClick={() => MPDStore.setRepeat(nextRepeat)}
                style={{ position: "relative" }}
            >
                {repeat === "track" && <span className={cl("repeat-1")}>1</span>}
                <Repeat />
            </Button>
        </Flex>
    );
}

function MPDSeekBar({ durationMs }: { durationMs: number; }) {
    const [storePosition, isSettingPosition, isPlaying] = useStateFromStores(
        [MPDStore],
        () => [MPDStore.basePositionMs, MPDStore.isSettingPosition, MPDStore.isPlaying]
    );

    const [position, setPosition] = useState(storePosition);
    const isSeeking = React.useRef(false);
    const seek = React.useMemo(() => debounce(async (v: number) => {
        await MPDStore.seek(v);
        isSeeking.current = false;
        setPosition(MPDStore.positionMs);
    }), []);

    useEffect(() => {
        if (!isSeeking.current)
            setPosition(MPDStore.positionMs);

        if (isPlaying && !isSettingPosition) {
            const interval = setInterval(() => {
                if (!isSeeking.current)
                    setPosition(MPDStore.positionMs);
            }, 1000);

            return () => clearInterval(interval);
        }
    }, [storePosition, isSettingPosition, isPlaying]);

    const onChange = (v: number) => {
        if (isSettingPosition) return;
        isSeeking.current = true;
        setPosition(v);
        seek(v);
    };

    return (
        <div id={cl("progress-bar")}>
            <Span
                size="xs"
                weight="medium"
                className={cl("progress-time") + " " + cl("time-left")}
                aria-label="Progress"
            >
                {formatDuration(position)}
            </Span>
            <SeekBar
                initialValue={position}
                minValue={0}
                maxValue={durationMs}
                onValueChange={onChange}
                asValueChanges={onChange}
                onValueRender={formatDuration}
            />
            <Span
                size="xs"
                weight="medium"
                className={cl("progress-time") + " " + cl("time-right")}
                aria-label="Total Duration"
            >
                {formatDuration(durationMs)}
            </Span>
        </div>
    );
}


function AlbumContextMenu({ artwork }: { artwork: { url: string; width: number; height: number; }; }) {
    const volume = useStateFromStores([MPDStore], () => MPDStore.volume);

    return (
        <Menu.Menu
            navId="mpd-album-menu"
            onClose={ContextMenuApi.closeContextMenu}
            aria-label="MPD Album Menu"
        >
            <Menu.MenuItem
                key="view-cover"
                id="view-cover"
                label="View Album Cover"
                // trolley
                action={() => openImageModal(artwork)}
                icon={ImageIcon}
            />
            {volume != null && (
                <Menu.MenuControlItem
                    id="mpd-volume"
                    key="mpd-volume"
                    label="Volume"
                    control={(props, ref) => (
                        <Menu.MenuSliderControl
                            {...props}
                            ref={ref}
                            value={volume}
                            minValue={0}
                            maxValue={100}
                            onChange={debounce((v: number) => MPDStore.setVolume(v))}
                        />
                    )}
                />
            )}
        </Menu.Menu>
    );
}

function makeContextMenuProps(type: "Song" | "Artist" | "Album", name: string) {
    return {
        onContextMenu: e =>
            ContextMenuApi.openContextMenu(e, () => <CopyContextMenu type={type} name={name} />)
    } satisfies React.HTMLAttributes<HTMLElement>;
}

function Info({ track }: { track: Track; }) {
    const { artworkUrl } = track;

    const [coverExpanded, setCoverExpanded] = useState(false);

    const i = (
        <>
            {artworkUrl && (
                <img
                    id={cl("album-image")}
                    src={artworkUrl}
                    alt="Album Image"
                    onClick={() => setCoverExpanded(!coverExpanded)}
                    onContextMenu={e => {
                        const { naturalHeight, naturalWidth } = e.currentTarget;
                        const artwork = {
                            url: artworkUrl,
                            width: naturalWidth || 1,
                            height: naturalHeight || 1
                        };

                        ContextMenuApi.openContextMenu(e, () => <AlbumContextMenu artwork={artwork} />);
                    }}
                />
            )}
        </>
    );

    if (coverExpanded && artworkUrl)
        return (
            <div id={cl("album-expanded-wrapper")}>
                {i}
            </div>
        );

    return (
        <div id={cl("info-wrapper")}>
            {i}
            <div id={cl("titles")}>
                <Paragraph
                    weight="semibold"
                    id={cl("song-title")}
                    className={cl("ellipoverflow")}
                    title={track.title}
                    {...makeContextMenuProps("Song", track.title)}
                >
                    {track.title}
                </Paragraph>
                {track.artists.some(Boolean) && (
                    <Paragraph className={cl(["ellipoverflow", "secondary-song-info"])}>
                        <span className={cl("song-info-prefix")}>by&nbsp;</span>
                        {track.artists.map((artist, i) => (
                            <React.Fragment key={`${artist}-${i}`}>
                                <span
                                    className={cl("artist")}
                                    style={{ fontSize: "inherit" }}
                                    title={artist}
                                    {...makeContextMenuProps("Artist", artist)}
                                >
                                    {artist}
                                </span>
                                {i !== track.artists.length - 1 && <span className={cl("comma")}>{", "}</span>}
                            </React.Fragment>
                        ))}
                    </Paragraph>
                )}
                {track.album && (
                    <Paragraph className={cl(["ellipoverflow", "secondary-song-info"])}>
                        <span className={cl("song-info-prefix")}>on&nbsp;</span>
                        <span
                            id={cl("album-title")}
                            className={cl("album")}
                            style={{ fontSize: "inherit" }}
                            title={track.album}
                            {...makeContextMenuProps("Album", track.album)}
                        >
                            {track.album}
                        </span>
                    </Paragraph>
                )}
            </div>
        </div>
    );
}

export function Player() {
    const track = useStateFromStores([MPDStore], () => MPDStore.track);
    const connected = useStateFromStores([MPDStore], () => MPDStore.connected);
    const isPlaying = useStateFromStores([MPDStore], () => MPDStore.isPlaying);
    const [shouldHide, setShouldHide] = useState(false);

    // Hide player after 5 minutes of inactivity

    React.useEffect(() => {
        setShouldHide(false);
        if (!isPlaying) {
            const timeout = setTimeout(() => setShouldHide(true), 1000 * 60 * 5);
            return () => clearTimeout(timeout);
        }
    }, [isPlaying]);

    if (!track || !connected || shouldHide)
        return null;

    return (
        <div id={cl("player")}>
            <Info track={track} />
            {track.durationMs > 0 && <MPDSeekBar durationMs={track.durationMs} />}
            <Controls />
        </div>
    );
}
