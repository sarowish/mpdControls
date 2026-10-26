/*
 * Vencord, a Discord client mod
 * Copyright (c) 2022 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";

import { Player } from "./src/components/PlayerComponent";
import { MPDStore } from "./src/MPDStore";
import hoverOnlyStyle from "./src/styles/hoverOnly.css?managed";

export const settings = definePluginSettings({
    hoverControls: {
        description: "Show controls on hover",
        type: OptionType.BOOLEAN,
        default: false,
        onChange: v => toggleHoverControls(v)
    },
    previousButtonRestartsTrack: {
        type: OptionType.BOOLEAN,
        description: "Restart currently playing track when pressing the previous button if playtime is >3s",
        default: true
    }
});

function toggleHoverControls(value: boolean) {
    (value ? enableStyle : disableStyle)(hoverOnlyStyle);
}

export default definePlugin({
    name: "MPDControls",
    description: "Adds an MPD player above the account panel",
    tags: ["Media", "Activity"],
    authors: [{ name: "sarowish", id: 968870622300098580n }],
    settings,
    patches: [
        {
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                // react.jsx)(AccountPanel, { ..., showTaglessAccountPanel: blah })
                match: /(?<=\i\.jsxs?\)\()(\i),{(?=[^}]*?userTag:\i,occluded:)/,
                // react.jsx(WrapperComponent, { VencordOriginal: AccountPanel, ...
                replace: "$self.PanelWrapper,{VencordOriginal:$1,"
            }
        }
    ],

    start() {
        toggleHoverControls(settings.store.hoverControls);
        MPDStore.start();
    },

    stop() {
        disableStyle(hoverOnlyStyle);
        MPDStore.stop();
    },

    PanelWrapper({ VencordOriginal, ...props }) {
        return (
            <>
                <ErrorBoundary
                    fallback={() => (
                        <div className="vc-mpd-fallback">
                            <p>Failed to render MPD player :(</p>
                            <p >Check the console for errors</p>
                        </div>
                    )}
                >
                    <Player />
                </ErrorBoundary>

                <VencordOriginal {...props} />
            </>
        );
    }
});
